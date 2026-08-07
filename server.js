require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const ADMIN_SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. API will not work until ENV is configured.');
}

const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SERVICE_ROLE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws }
});

const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: false }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(morgan('tiny'));

const corsOrigins = (process.env.CORS_ORIGIN || '*').split(',').map(v => v.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || corsOrigins.includes('*') || corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, true);
  },
  credentials: true
}));

app.use(express.static(path.join(__dirname, 'public')));

function signToken(user) {
  return jwt.sign({ id: user.id, login: user.login, role: user.role, full_name: user.full_name }, JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Avtorizatsiya tokeni topilmadi' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Token eskirgan yoki noto‘g‘ri' });
  }
}

const ROLE_LEVEL = { viewer: 1, operator: 2, admin: 3 };
function roleLevel(user) { return ROLE_LEVEL[user?.role] || 0; }
function requireLevel(level) {
  return (req, res, next) => {
    if (roleLevel(req.user) < level) return res.status(403).json({ error: 'Bu amal uchun ruxsat yetarli emas' });
    next();
  };
}
const requireWrite = requireLevel(2);
const requireAdmin = requireLevel(3);

function n(value) {
  const num = Number(String(value ?? 0).replace(/\s/g, '').replace(/,/g, '.'));
  return Number.isFinite(num) ? num : 0;
}

function moneyFromInputs(amountSum, amountUsd, exchangeRate) {
  const sum = n(amountSum);
  const usd = n(amountUsd);
  const rate = n(exchangeRate);
  if (sum > 0) return Math.round(sum * 100) / 100;
  if (usd > 0 && rate > 0) return Math.round(usd * rate * 100) / 100;
  return 0;
}

function monthNameUz(month) {
  const names = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
  return names[Number(month) - 1] || String(month);
}
function periodLabel(year, month) { return `${monthNameUz(month)} ${year}`; }
function dateOnly(d) { return d ? String(d).slice(0, 10) : null; }
function periodStart(period) { return `${period.year}-${String(period.month).padStart(2, '0')}-01`; }
function periodEnd(period) {
  const y = Number(period.year); const m = Number(period.month);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period.year}-${String(period.month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}
function ymKey(p) { return Number(p.year) * 100 + Number(p.month); }
function comparePeriodAsc(a, b) { return ymKey(a) - ymKey(b); }
function normalizeRowAmounts(row) {
  const rate = n(row.exchange_rate);
  const amountSum = moneyFromInputs(row.amount_sum, row.amount_usd, row.exchange_rate);
  return { ...row, amount_sum: amountSum, amount_usd: n(row.amount_usd), exchange_rate: rate };
}

async function dbList(table, select = '*', order = null, optional = false) {
  let q = supabase.from(table).select(select);
  if (order) q = q.order(order.column, { ascending: order.ascending ?? true });
  const { data, error } = await q;
  if (error) {
    if (optional && /does not exist|schema cache|Could not find/i.test(error.message || '')) return [];
    throw error;
  }
  return data || [];
}

async function getAllData() {
  const [companies, periods, salaryRates, payments, expenses, services, openingDebts, allocations, companyPeriodStatuses] = await Promise.all([
    dbList('afc_companies', '*', { column: 'created_at', ascending: true }),
    dbList('afc_periods', '*', { column: 'year', ascending: false }),
    dbList('afc_salary_rates', '*', { column: 'effective_from', ascending: true }),
    dbList('afc_payments', '*', { column: 'payment_date', ascending: false }),
    dbList('afc_expenses', '*', { column: 'expense_date', ascending: false }),
    dbList('afc_services', '*', { column: 'service_date', ascending: false }),
    dbList('afc_opening_debts', '*', { column: 'debt_date', ascending: false }, true),
    dbList('afc_payment_allocations', '*', { column: 'created_at', ascending: true }, true),
    dbList('afc_company_period_statuses', '*', { column: 'created_at', ascending: true }, true)
  ]);
  return { companies, periods, salaryRates, payments, expenses, services, openingDebts, allocations, companyPeriodStatuses };
}

function pickArchiveMeta(beforeValue, afterValue) {
  const source = afterValue || beforeValue || {};
  return {
    company_id: source.company_id || source.id && String(source.table_name || '').includes('company') ? source.id : (source.company?.id || null),
    period_id: source.period_id || null
  };
}

async function writeArchiveRecord(req, action, tableName, recordId, beforeValue, afterValue, note = '') {
  try {
    const source = afterValue || beforeValue || {};
    let company_id = source.company_id || null;
    if (!company_id && tableName === 'afc_companies') company_id = recordId || source.id || null;
    const period_id = source.period_id || null;
    await supabase.from('afc_archive_records').insert({
      user_id: req.user?.id || null,
      user_login: req.user?.login || '',
      user_role: req.user?.role || '',
      action,
      table_name: tableName,
      record_id: recordId || null,
      company_id,
      period_id,
      before_value: beforeValue || null,
      after_value: afterValue || null,
      note,
      ip_address: req.ip || '',
      user_agent: req.headers['user-agent'] || ''
    });
  } catch (e) {
    if (!/does not exist|schema cache|relation .* does not exist/i.test(e.message || '')) console.warn('archive skipped:', e.message);
  }
}

async function writeAudit(req, action, tableName, recordId, beforeValue, afterValue, note = '') {
  try {
    await supabase.from('afc_audit_logs').insert({
      user_id: req.user?.id || null,
      user_login: req.user?.login || '',
      user_role: req.user?.role || '',
      action,
      table_name: tableName,
      record_id: recordId || null,
      before_value: beforeValue || null,
      after_value: afterValue || null,
      note
    });
  } catch (e) {
    console.warn('audit skipped:', e.message);
  }
  await writeArchiveRecord(req, action, tableName, recordId, beforeValue, afterValue, note);
}

async function assertPeriodOpen(periodId) {
  if (!periodId) return;
  const { data, error } = await supabase.from('afc_periods').select('id,is_closed,period_name').eq('id', periodId).single();
  if (error) throw error;
  if (data?.is_closed) {
    const err = new Error(`${data.period_name || 'Tanlangan davr'} yopilgan. Avval davrni qayta oching.`);
    err.status = 423;
    throw err;
  }
}

function activeSalaryForPeriod(companyId, period, salaryRates) {
  const end = periodEnd(period);
  const rates = salaryRates
    .filter(r => r.company_id === companyId && dateOnly(r.effective_from) <= end)
    .sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const rate = rates[rates.length - 1];
  if (!rate) return { amount_sum: 0, amount_usd: 0, exchange_rate: 0, effective_from: null, note: '' };
  return { ...rate, amount_sum: moneyFromInputs(rate.amount_sum, rate.amount_usd, rate.exchange_rate), amount_usd: n(rate.amount_usd), exchange_rate: n(rate.exchange_rate) };
}

function companyPeriodStatus(companyId, periodId, data) {
  return (data.companyPeriodStatuses || []).find(x => x.company_id === companyId && x.period_id === periodId) || null;
}

function statusLabel(value) {
  const map = {
    active: 'Faol',
    problem: 'Muammoli',
    paused: 'Vaqtincha to‘xtagan',
    no_salary: 'Maosh hisoblanmaydi',
    archived: 'Arxiv',
    inactive: 'Faol emas'
  };
  return map[String(value || '').toLowerCase()] || (value || 'Faol');
}

function salaryEnabledFromStatus(company, periodStatus) {
  // Korxona statusi vizual/filtr uchun. Hisob-kitobni buzmaslik uchun ish haqi
  // faqat tanlangan davr statusi orqali o'chiriladi.
  const periodValue = String(periodStatus?.status || '').toLowerCase();
  if (periodStatus) {
    if (['no_salary', 'paused', 'inactive'].includes(periodValue)) return false;
    return periodStatus.salary_enabled !== false;
  }
  return true;
}

function openingDebtForCompanyPeriod(companyId, periodId, data) {
  const list = (data.openingDebts || []).filter(d => d.company_id === companyId && d.period_id === periodId).map(normalizeRowAmounts);
  return {
    opening_debt_sum: list.reduce((acc, d) => acc + d.amount_sum, 0),
    opening_debt_usd: list.reduce((acc, d) => acc + n(d.amount_usd), 0),
    opening_debt_items: list
  };
}

function chargedForCompanyPeriod(companyId, periodId, period, data) {
  const company = (data.companies || []).find(c => c.id === companyId) || {};
  const periodStatus = companyPeriodStatus(companyId, periodId, data);
  const salary = activeSalaryForPeriod(companyId, period, data.salaryRates);
  const salaryEnabled = salaryEnabledFromStatus(company, periodStatus);
  const salarySum = salaryEnabled ? n(salary.amount_sum) : 0;
  const salaryUsd = salaryEnabled ? n(salary.amount_usd) : 0;
  const serviceList = data.services.filter(s => s.company_id === companyId && s.period_id === periodId);
  const servicesSum = serviceList.reduce((acc, s) => acc + moneyFromInputs(s.amount_sum, s.amount_usd, s.exchange_rate), 0);
  const servicesUsd = serviceList.reduce((acc, s) => acc + n(s.amount_usd), 0);
  const periodStatusValue = periodStatus?.status || (salaryEnabled ? 'active' : (company.status || 'no_salary'));
  return {
    salary_sum: salarySum,
    salary_usd: salaryUsd,
    base_salary_sum: n(salary.amount_sum),
    base_salary_usd: n(salary.amount_usd),
    salary_enabled: salaryEnabled,
    salary_rate: salary,
    company_status: company.status || 'active',
    period_status_id: periodStatus?.id || null,
    period_status: periodStatusValue,
    period_status_label: salaryEnabled ? statusLabel(periodStatusValue) : 'Maosh hisoblanmaydi',
    period_status_comment: periodStatus?.comment || '',
    services_sum: servicesSum,
    services_usd: servicesUsd,
    charged_sum: salarySum + servicesSum,
    service_count: serviceList.length
  };
}

function allocatedPaidForCompanyPeriod(companyId, periodId, data, excludePaymentId = null) {
  const allocationPaymentIds = new Set((data.allocations || []).map(a => a.payment_id));
  const allocated = (data.allocations || [])
    .filter(a => a.company_id === companyId && a.period_id === periodId && a.payment_id !== excludePaymentId)
    .reduce((acc, a) => acc + n(a.allocated_sum), 0);
  // Eski yozuvlar uchun: agar to‘lovga allocation yozilmagan bo‘lsa, payment.period_id bo‘yicha hisoblanadi.
  const fallback = (data.payments || [])
    .filter(p => p.company_id === companyId && p.period_id === periodId && p.id !== excludePaymentId && !allocationPaymentIds.has(p.id))
    .reduce((acc, p) => acc + moneyFromInputs(p.amount_sum, p.amount_usd, p.exchange_rate), 0);
  return allocated + fallback;
}

function companyPeriodBalance(companyId, period, data, excludePaymentId = null) {
  const charged = chargedForCompanyPeriod(companyId, period.id, period, data);
  const opening = openingDebtForCompanyPeriod(companyId, period.id, data);
  const paidSum = allocatedPaidForCompanyPeriod(companyId, period.id, data, excludePaymentId);
  const paidToOpening = Math.min(opening.opening_debt_sum, paidSum);
  const paidAfterOpening = Math.max(paidSum - opening.opening_debt_sum, 0);
  const openingRemaining = Math.max(opening.opening_debt_sum - paidSum, 0);
  const currentDebt = Math.max(charged.charged_sum - paidAfterOpening, 0);
  const debtSum = openingRemaining + currentDebt;
  const overpaid = Math.max(paidSum - opening.opening_debt_sum - charged.charged_sum, 0);
  return {
    ...charged,
    ...opening,
    paid_sum: paidSum,
    paid_to_opening_sum: paidToOpening,
    paid_to_current_sum: Math.min(paidAfterOpening, charged.charged_sum),
    opening_debt_remaining: openingRemaining,
    current_debt: currentDebt,
    debt_sum: debtSum,
    overpaid_sum: overpaid,
    obligation_sum: opening.opening_debt_sum + charged.charged_sum
  };
}

function statusFromAmounts(charged, paid, totalDebt) {
  if (charged <= 0 && paid <= 0 && totalDebt <= 0) return 'hisoblanmagan';
  if (totalDebt <= 0) return 'toliq berilgan';
  if (paid <= 0) return 'berilmagan';
  if (paid > 0 && totalDebt > 0) return 'qisman berilgan';
  return 'qoldiq mavjud';
}

function allocationSummary(paymentId, data) {
  const byPeriod = new Map((data.periods || []).map(p => [p.id, p.period_name || periodLabel(p.year, p.month)]));
  const list = (data.allocations || []).filter(a => a.payment_id === paymentId);
  if (!list.length) return '';
  return list.map(a => `${byPeriod.get(a.period_id) || 'Davr'}: ${Math.round(n(a.allocated_sum)).toLocaleString('ru-RU')}`).join('; ');
}

function buildDashboard(selectedPeriodId, data) {
  const periods = [...data.periods].sort(comparePeriodAsc);
  const selectedPeriod = data.periods.find(p => p.id === selectedPeriodId) || periods[periods.length - 1];
  if (!selectedPeriod) return { empty: true, message: 'Avval oy yarating' };
  const selectedKey = ymKey(selectedPeriod);
  const priorPeriods = periods.filter(p => ymKey(p) < selectedKey);
  const companiesActive = data.companies.filter(c => c.status !== 'archived');

  const companyRows = companiesActive.map(company => {
    const current = companyPeriodBalance(company.id, selectedPeriod, data);
    const oldDebtItems = priorPeriods.map(p => {
      const b = companyPeriodBalance(company.id, p, data);
      return {
        period_id: p.id,
        period_name: p.period_name || periodLabel(p.year, p.month),
        opening_debt_sum: b.opening_debt_sum,
        salary_sum: b.salary_sum,
        services_sum: b.services_sum,
        charged_sum: b.charged_sum,
        obligation_sum: b.obligation_sum,
        paid_sum: b.paid_sum,
        debt_sum: b.debt_sum
      };
    }).filter(item => item.debt_sum > 0.001);
    if (current.opening_debt_remaining > 0.001) {
      oldDebtItems.push({
        period_id: selectedPeriod.id,
        period_name: `${selectedPeriod.period_name || periodLabel(selectedPeriod.year, selectedPeriod.month)} — davr boshidagi qarz`,
        opening_debt_sum: current.opening_debt_sum,
        salary_sum: 0,
        services_sum: 0,
        charged_sum: 0,
        obligation_sum: current.opening_debt_sum,
        paid_sum: current.paid_to_opening_sum,
        debt_sum: current.opening_debt_remaining
      });
    }
    const previousDebt = oldDebtItems.reduce((acc, it) => acc + it.debt_sum, 0);
    const totalDebt = previousDebt + current.current_debt;
    const paymentStatus = (!current.salary_enabled && current.charged_sum <= 0 && current.paid_sum <= 0 && totalDebt <= 0)
      ? 'maosh hisoblanmaydi'
      : statusFromAmounts(current.charged_sum, current.paid_sum, totalDebt);
    return {
      company_id: company.id,
      company_name: company.name,
      stir: company.stir,
      director_name: company.director_name,
      phone: company.phone,
      note: company.note,
      company_status: company.status || 'active',
      company_status_label: statusLabel(company.status || 'active'),
      period_status_id: current.period_status_id,
      period_status: current.period_status,
      period_status_label: current.period_status_label,
      period_status_comment: current.period_status_comment,
      salary_enabled: current.salary_enabled,
      salary_sum: current.salary_sum,
      salary_usd: current.salary_usd,
      base_salary_sum: current.base_salary_sum,
      base_salary_usd: current.base_salary_usd,
      services_sum: current.services_sum,
      service_count: current.service_count,
      opening_debt_sum: current.opening_debt_sum,
      opening_debt_remaining: current.opening_debt_remaining,
      charged_sum: current.charged_sum,
      obligation_sum: current.obligation_sum,
      paid_sum: current.paid_sum,
      paid_to_current_sum: current.paid_to_current_sum,
      paid_to_opening_sum: current.paid_to_opening_sum,
      current_debt: current.current_debt,
      previous_debt: previousDebt,
      total_debt: totalDebt,
      overpaid_sum: current.overpaid_sum,
      status: paymentStatus,
      salary_effective_from: current.salary_rate.effective_from,
      old_debt_items: oldDebtItems
    };
  });

  const periodExpenses = data.expenses.filter(e => e.period_id === selectedPeriod.id).map(normalizeRowAmounts);
  const periodPayments = data.payments.filter(p => p.period_id === selectedPeriod.id).map(normalizeRowAmounts);
  const periodServices = data.services.filter(s => s.period_id === selectedPeriod.id).map(normalizeRowAmounts);
  const periodOpeningDebts = data.openingDebts.filter(d => d.period_id === selectedPeriod.id).map(normalizeRowAmounts);

  const totalCharged = companyRows.reduce((acc, r) => acc + r.charged_sum, 0);
  const totalSalary = companyRows.reduce((acc, r) => acc + r.salary_sum, 0);
  const totalService = companyRows.reduce((acc, r) => acc + r.services_sum, 0);
  const totalOpeningDebt = companyRows.reduce((acc, r) => acc + r.opening_debt_sum, 0);
  const totalPaid = periodPayments.reduce((acc, p) => acc + p.amount_sum, 0); // tanlangan oyda kassaga/bankka kelgan jami pul
  const totalCurrentPaid = companyRows.reduce((acc, r) => acc + r.paid_to_current_sum, 0); // faqat joriy oy xizmatlariga yopilgan tushum
  const oldDebtCollected = Math.max(totalPaid - totalCurrentPaid, 0); // eski qarz/avans bo‘yicha kelgan pul, oylik tushumga kirmaydi
  const totalExpenses = periodExpenses.reduce((acc, e) => acc + e.amount_sum, 0);
  const totalDebt = companyRows.reduce((acc, r) => acc + r.total_debt, 0);
  const oldDebt = companyRows.reduce((acc, r) => acc + r.previous_debt, 0);
  const currentDebt = companyRows.reduce((acc, r) => acc + r.current_debt, 0);

  const periodsForChart = periods.filter(p => ymKey(p) <= selectedKey).slice(-6);
  const chart = periodsForChart.map(p => {
    const rowsForP = companiesActive.map(c => companyPeriodBalance(c.id, p, data));
    const income = rowsForP.reduce((acc, r) => acc + r.charged_sum, 0);
    const pay = rowsForP.reduce((acc, r) => acc + r.paid_to_current_sum, 0);
    const cashIn = data.payments.filter(x => x.period_id === p.id).reduce((acc, x) => acc + moneyFromInputs(x.amount_sum, x.amount_usd, x.exchange_rate), 0);
    const oldCollected = Math.max(cashIn - pay, 0);
    const exp = data.expenses.filter(x => x.period_id === p.id).reduce((acc, x) => acc + moneyFromInputs(x.amount_sum, x.amount_usd, x.exchange_rate), 0);
    return { label: monthNameUz(p.month).slice(0, 3), income, paid: pay, old_collected: oldCollected, cash_in: cashIn, expenses: exp, profit: pay - exp };
  });

  const companyById = new Map(data.companies.map(c => [c.id, c]));
  const paymentsFull = [...periodPayments]
    .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map(p => ({ ...p, company_name: companyById.get(p.company_id)?.name || 'Korxona', allocation_summary: allocationSummary(p.id, data) }));
  const expensesFull = [...periodExpenses]
    .sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)) || String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const servicesFull = [...periodServices]
    .sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map(s => ({ ...s, company_name: companyById.get(s.company_id)?.name || 'Korxona' }));
  const openingFull = [...periodOpeningDebts]
    .sort((a, b) => String(b.debt_date).localeCompare(String(a.debt_date)) || String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .map(d => ({ ...d, company_name: companyById.get(d.company_id)?.name || 'Korxona' }));

  return {
    empty: false,
    selected_period: selectedPeriod,
    periods: data.periods.sort((a, b) => ymKey(b) - ymKey(a)),
    role: null,
    totals: {
      total_salary: totalSalary,
      total_services: totalService,
      total_opening_debt: totalOpeningDebt,
      total_charged: totalCharged,
      total_paid: totalPaid,
      total_current_paid: totalCurrentPaid,
      old_debt_collected: oldDebtCollected,
      total_cash_in: totalPaid,
      total_expenses: totalExpenses,
      calculated_profit: totalCharged - totalExpenses,
      real_profit: totalCurrentPaid - totalExpenses,
      cash_result: totalPaid - totalExpenses,
      total_debt: totalDebt,
      old_debt: oldDebt,
      current_debt: currentDebt,
      expected_income: currentDebt,
      expected_old_debt: oldDebt,
      expected_current_debt: currentDebt,
      companies_count: companyRows.length
    },
    companies: companyRows.sort((a, b) => b.total_debt - a.total_debt || a.company_name.localeCompare(b.company_name)),
    latest_payments: paymentsFull.slice(0, 5),
    latest_expenses: expensesFull.slice(0, 5),
    latest_services: servicesFull.slice(0, 5),
    payments: paymentsFull,
    expenses: expensesFull,
    services: servicesFull,
    opening_debts: openingFull,
    period_statuses: (data.companyPeriodStatuses || []).filter(x => x.period_id === selectedPeriod.id),
    chart
  };
}

async function allocatePayment(paymentId, reqForAudit = null) {
  const { data: payment, error: paymentError } = await supabase.from('afc_payments').select('*').eq('id', paymentId).single();
  if (paymentError) throw paymentError;
  await supabase.from('afc_payment_allocations').delete().eq('payment_id', paymentId);
  const amount = moneyFromInputs(payment.amount_sum, payment.amount_usd, payment.exchange_rate);
  if (amount <= 0) return [];
  const all = await getAllData();
  const targetPeriod = all.periods.find(p => p.id === payment.period_id);
  if (!targetPeriod) return [];
  const scope = String(payment.payment_scope || '').toLowerCase();
  const singlePeriod = scope.includes('faqat') || scope.includes('joriy') || scope.includes('xizmat') || scope.includes('avans');
  let remaining = amount;
  const rows = [];
  const targetPeriods = singlePeriod
    ? [targetPeriod]
    : all.periods.filter(p => ymKey(p) <= ymKey(targetPeriod)).sort(comparePeriodAsc);
  for (const p of targetPeriods) {
    if (remaining <= 0.001) break;
    const b = companyPeriodBalance(payment.company_id, p, all, payment.id);
    const due = singlePeriod ? remaining : Math.max(b.debt_sum, 0);
    if (due <= 0.001) continue;
    const allocated = Math.min(remaining, due);
    rows.push({ payment_id: payment.id, company_id: payment.company_id, period_id: p.id, allocated_sum: Math.round(allocated * 100) / 100 });
    remaining -= allocated;
  }
  if (remaining > 0.001) {
    rows.push({ payment_id: payment.id, company_id: payment.company_id, period_id: payment.period_id, allocated_sum: Math.round(remaining * 100) / 100 });
  }
  if (rows.length) {
    const { error } = await supabase.from('afc_payment_allocations').insert(rows);
    if (error) throw error;
  }
  if (reqForAudit) await writeAudit(reqForAudit, 'allocate', 'afc_payment_allocations', payment.id, null, rows, 'To‘lov avtomatik taqsimlandi');
  return rows;
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'ALL FINANCE CASH', version: '1.8.0', time: new Date().toISOString() }));

app.post('/api/setup/create-admin', asyncRoute(async (req, res) => {
  const { setup_token, login, password, full_name } = req.body || {};
  if (!ADMIN_SETUP_TOKEN) return res.status(400).json({ error: 'ADMIN_SETUP_TOKEN Render ENV’da o‘rnatilmagan' });
  if (setup_token !== ADMIN_SETUP_TOKEN) return res.status(403).json({ error: 'Setup token noto‘g‘ri' });
  if (!login || !password) return res.status(400).json({ error: 'login va password majburiy' });
  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('afc_users').insert({ login, password_hash, full_name: full_name || 'Admin', role: 'admin' }).select('id,login,full_name,role').single();
  if (error) throw error;
  res.json({ ok: true, user: data });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Login va parol kiriting' });
  const { data: user, error } = await supabase.from('afc_users').select('*').eq('login', login).eq('is_active', true).single();
  if (error || !user) return res.status(401).json({ error: 'Login yoki parol noto‘g‘ri' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Login yoki parol noto‘g‘ri' });
  res.json({ token: signToken(user), user: { id: user.id, login: user.login, full_name: user.full_name, role: user.role } });
}));

app.get('/api/auth/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/periods', auth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('afc_periods').select('*').order('year', { ascending: false }).order('month', { ascending: false });
  if (error) throw error;
  res.json({ periods: data || [] });
}));

app.post('/api/periods', auth, requireAdmin, asyncRoute(async (req, res) => {
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'Yil va oy noto‘g‘ri' });
  const row = { year, month, period_name: req.body.period_name || periodLabel(year, month), default_usd_rate: n(req.body.default_usd_rate), is_closed: false };
  const { data, error } = await supabase.from('afc_periods').upsert(row, { onConflict: 'year,month' }).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'upsert', 'afc_periods', data.id, null, data, 'Davr yaratildi/yangi holatga keltirildi');
  res.json({ period: data });
}));

app.put('/api/periods/:id/close', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before } = await supabase.from('afc_periods').select('*').eq('id', req.params.id).single();
  const { data, error } = await supabase.from('afc_periods').update({ is_closed: true, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'close', 'afc_periods', req.params.id, before, data, 'Davr yopildi');
  res.json({ period: data });
}));

app.put('/api/periods/:id/reopen', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before } = await supabase.from('afc_periods').select('*').eq('id', req.params.id).single();
  const { data, error } = await supabase.from('afc_periods').update({ is_closed: false, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'reopen', 'afc_periods', req.params.id, before, data, 'Davr qayta ochildi');
  res.json({ period: data });
}));

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  const dashboard = buildDashboard(req.query.period_id, data);
  dashboard.role = req.user.role;
  res.json(dashboard);
}));

app.get('/api/companies', auth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('afc_companies').select('*').order('name', { ascending: true });
  if (error) throw error;
  res.json({ companies: data || [] });
}));

app.post('/api/companies', auth, requireAdmin, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Korxona nomi majburiy' });
  const companyRow = { name: body.name, stir: body.stir || '', director_name: body.director_name || '', phone: body.phone || '', note: body.note || '', status: body.status || 'active' };
  const { data: company, error } = await supabase.from('afc_companies').insert(companyRow).select('*').single();
  if (error) throw error;
  const salary = {
    company_id: company.id,
    amount_sum: moneyFromInputs(body.salary_sum, body.salary_usd, body.exchange_rate),
    amount_usd: n(body.salary_usd),
    exchange_rate: n(body.exchange_rate),
    effective_from: body.effective_from || new Date().toISOString().slice(0, 10),
    note: body.salary_note || body.note || 'Boshlang‘ich ish haqi summasi',
    created_by: req.user.id
  };
  await supabase.from('afc_salary_rates').insert(salary);
  await writeAudit(req, 'insert', 'afc_companies', company.id, null, { company, salary }, 'Korxona qo‘shildi');
  res.json({ company });
}));

app.put('/api/companies/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const { data: before } = await supabase.from('afc_companies').select('*').eq('id', req.params.id).single();
  const row = { name: body.name, stir: body.stir || '', director_name: body.director_name || '', phone: body.phone || '', note: body.note || '', status: body.status || before?.status || 'active', updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('afc_companies').update(row).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'update', 'afc_companies', req.params.id, before, data, 'Korxona tahrirlandi');
  res.json({ company: data });
}));

app.delete('/api/companies/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before } = await supabase.from('afc_companies').select('*').eq('id', req.params.id).single();
  const { data, error } = await supabase.from('afc_companies').update({ status: 'archived', updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'archive', 'afc_companies', req.params.id, before, data, 'Korxona arxivga o‘tkazildi');
  res.json({ company: data });
}));


app.put('/api/companies/:id/restore', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_companies').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  const { data, error } = await supabase.from('afc_companies').update({ status: 'active', updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'restore', 'afc_companies', req.params.id, before, data, 'Korxona arxivdan tiklandi');
  res.json({ company: data });
}));

app.delete('/api/companies/:id/hard-delete', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_companies').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await writeAudit(req, 'hard_delete_requested', 'afc_companies', req.params.id, before, null, 'Korxonani bazadan butunlay o‘chirishdan oldin snapshot arxivga olindi');
  const { error } = await supabase.from('afc_companies').delete().eq('id', req.params.id);
  if (error) throw error;
  await writeAudit(req, 'hard_delete', 'afc_companies', req.params.id, before, null, 'Korxona bazadan butunlay o‘chirildi');
  res.json({ ok: true });
}));


app.put('/api/companies/:id/period-status', auth, requireAdmin, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const periodId = body.period_id;
  if (!periodId) return res.status(400).json({ error: 'Davr majburiy' });
  await assertPeriodOpen(periodId);
  const status = body.status || 'active';
  const noSalary = ['no_salary', 'paused', 'inactive'].includes(String(status).toLowerCase());
  const salaryEnabled = noSalary ? false : !(String(body.salary_enabled).toLowerCase() === 'false' || body.salary_enabled === false || body.salary_enabled === '0');
  const { data: before, error: beforeError } = await supabase
    .from('afc_company_period_statuses')
    .select('*')
    .eq('company_id', req.params.id)
    .eq('period_id', periodId)
    .maybeSingle();
  if (beforeError) throw beforeError;
  const row = {
    company_id: req.params.id,
    period_id: periodId,
    status,
    salary_enabled: salaryEnabled,
    comment: body.comment || '',
    created_by: req.user.id,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase
    .from('afc_company_period_statuses')
    .upsert(row, { onConflict: 'company_id,period_id' })
    .select('*')
    .single();
  if (error) throw error;
  await writeAudit(req, before ? 'update' : 'insert', 'afc_company_period_statuses', data.id, before, data, salaryEnabled ? 'Korxonaning davr statusi yangilandi' : 'Ushbu davr uchun ish haqi hisoblanmaydi');
  res.json({ period_status: data });
}));

app.delete('/api/companies/:id/period-status/:periodId', auth, requireAdmin, asyncRoute(async (req, res) => {
  await assertPeriodOpen(req.params.periodId);
  const { data: before, error: beforeError } = await supabase
    .from('afc_company_period_statuses')
    .select('*')
    .eq('company_id', req.params.id)
    .eq('period_id', req.params.periodId)
    .maybeSingle();
  if (beforeError) throw beforeError;
  if (!before) return res.json({ ok: true });
  const { error } = await supabase.from('afc_company_period_statuses').delete().eq('id', before.id);
  if (error) throw error;
  await writeAudit(req, 'delete', 'afc_company_period_statuses', before.id, before, null, 'Davr statusi bekor qilindi');
  res.json({ ok: true });
}));

app.post('/api/companies/:id/salary-rate', auth, requireAdmin, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.effective_from) return res.status(400).json({ error: 'Qaysi sanadan amal qilishi majburiy' });
  if (!body.note) return res.status(400).json({ error: 'O‘zgarish izohi majburiy' });
  const row = { company_id: req.params.id, amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), effective_from: body.effective_from, note: body.note, created_by: req.user.id };
  const { data, error } = await supabase.from('afc_salary_rates').insert(row).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'insert', 'afc_salary_rates', data.id, null, data, 'Ish haqi summasi o‘zgartirildi');
  res.json({ salary_rate: data });
}));


app.get('/api/salary-rates/:id', auth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('afc_salary_rates').select('*').eq('id', req.params.id).single();
  if (error) throw error;
  res.json({ salary_rate: data });
}));

app.put('/api/salary-rates/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_salary_rates').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  const body = req.body || {};
  if (!body.effective_from) return res.status(400).json({ error: 'Qaysi sanadan amal qilishi majburiy' });
  if (!body.note) return res.status(400).json({ error: 'O‘zgarish izohi majburiy' });
  const row = {
    amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate),
    amount_usd: n(body.amount_usd),
    exchange_rate: n(body.exchange_rate),
    effective_from: body.effective_from,
    note: body.note,
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('afc_salary_rates').update(row).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'update', 'afc_salary_rates', req.params.id, before, data, 'Ish haqi boshlang‘ich/tarixiy summasi tahrirlandi');
  res.json({ salary_rate: data });
}));

app.delete('/api/salary-rates/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_salary_rates').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  const { count, error: countError } = await supabase.from('afc_salary_rates').select('id', { count: 'exact', head: true }).eq('company_id', before.company_id);
  if (countError) throw countError;
  if ((count || 0) <= 1) return res.status(400).json({ error: 'Oxirgi ish haqi yozuvini o‘chirib bo‘lmaydi. Avval yangi summa kiriting.' });
  const { error } = await supabase.from('afc_salary_rates').delete().eq('id', req.params.id);
  if (error) throw error;
  await writeAudit(req, 'delete', 'afc_salary_rates', req.params.id, before, null, 'Ish haqi tarixi yozuvi o‘chirildi');
  res.json({ ok: true });
}));

app.get('/api/companies/:id/salary-history', auth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('afc_salary_rates').select('*').eq('company_id', req.params.id).order('effective_from', { ascending: false });
  if (error) throw error;
  res.json({ history: data || [] });
}));

app.get('/api/companies/:id/debt-details', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  const selected = data.periods.find(p => p.id === req.query.period_id) || data.periods.sort(comparePeriodAsc).at(-1);
  if (!selected) return res.json({ items: [] });
  const prior = data.periods.filter(p => ymKey(p) < ymKey(selected)).sort(comparePeriodAsc);
  const items = prior.map(p => {
    const b = companyPeriodBalance(req.params.id, p, data);
    return { period_id: p.id, period_name: p.period_name || periodLabel(p.year, p.month), opening_debt_sum: b.opening_debt_sum, salary_sum: b.salary_sum, services_sum: b.services_sum, charged_sum: b.charged_sum, obligation_sum: b.obligation_sum, paid_sum: b.paid_sum, debt_sum: b.debt_sum };
  }).filter(i => i.debt_sum > 0.001);
  const current = companyPeriodBalance(req.params.id, selected, data);
  if (current.opening_debt_remaining > 0.001) {
    items.push({ period_id: selected.id, period_name: `${selected.period_name || periodLabel(selected.year, selected.month)} — davr boshidagi qarz`, opening_debt_sum: current.opening_debt_sum, salary_sum: 0, services_sum: 0, charged_sum: 0, obligation_sum: current.opening_debt_sum, paid_sum: current.paid_to_opening_sum, debt_sum: current.opening_debt_remaining });
  }
  res.json({ items });
}));

app.get('/api/companies/:id/card', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  const company = data.companies.find(c => c.id === req.params.id);
  if (!company) return res.status(404).json({ error: 'Korxona topilmadi' });
  const periods = data.periods.sort(comparePeriodAsc);
  const rows = periods.map(p => {
    const b = companyPeriodBalance(company.id, p, data);
    return { period_id: p.id, period_name: p.period_name || periodLabel(p.year, p.month), is_closed: p.is_closed, ...b };
  });
  const payments = data.payments.filter(p => p.company_id === company.id).map(p => ({ ...normalizeRowAmounts(p), allocation_summary: allocationSummary(p.id, data) })).sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)));
  const services = data.services.filter(s => s.company_id === company.id).map(normalizeRowAmounts).sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)));
  const opening_debts = data.openingDebts.filter(d => d.company_id === company.id).map(normalizeRowAmounts).sort((a, b) => String(b.debt_date).localeCompare(String(a.debt_date)));
  const salary_history = data.salaryRates.filter(s => s.company_id === company.id).sort((a, b) => String(b.effective_from).localeCompare(String(a.effective_from)));
  res.json({ company, rows, payments, services, opening_debts, salary_history });
}));

app.post('/api/opening-debts', auth, requireWrite, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.company_id || !body.period_id) return res.status(400).json({ error: 'Korxona va davr majburiy' });
  await assertPeriodOpen(body.period_id);
  const row = { company_id: body.company_id, period_id: body.period_id, debt_date: body.debt_date || periodStart({ year: new Date().getFullYear(), month: new Date().getMonth() + 1 }), amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), comment: body.comment || '', created_by: req.user.id };
  const { data, error } = await supabase.from('afc_opening_debts').insert(row).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'insert', 'afc_opening_debts', data.id, null, data, 'Davr boshidagi qarz kiritildi');
  res.json({ opening_debt: data });
}));

app.put('/api/opening-debts/:id', auth, requireWrite, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_opening_debts').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  const body = req.body || {};
  const row = { company_id: body.company_id || before.company_id, period_id: body.period_id || before.period_id, debt_date: body.debt_date || before.debt_date, amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), comment: body.comment || '', updated_at: new Date().toISOString() };
  await assertPeriodOpen(row.period_id);
  const { data, error } = await supabase.from('afc_opening_debts').update(row).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'update', 'afc_opening_debts', req.params.id, before, data, 'Davr boshidagi qarz tahrirlandi');
  res.json({ opening_debt: data });
}));

app.delete('/api/opening-debts/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_opening_debts').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  const { error } = await supabase.from('afc_opening_debts').delete().eq('id', req.params.id);
  if (error) throw error;
  await writeAudit(req, 'delete', 'afc_opening_debts', req.params.id, before, null, 'Davr boshidagi qarz o‘chirildi');
  res.json({ ok: true });
}));

app.post('/api/payments', auth, requireWrite, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.company_id || !body.period_id || !body.payment_date) return res.status(400).json({ error: 'Korxona, davr va to‘lov sanasi majburiy' });
  await assertPeriodOpen(body.period_id);
  const row = { company_id: body.company_id, period_id: body.period_id, payment_date: body.payment_date, payment_type: body.payment_type || 'naqd', amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), payment_scope: body.payment_scope || 'avval eski qarzlar, keyin joriy oy', comment: body.comment || '', created_by: req.user.id };
  const { data, error } = await supabase.from('afc_payments').insert(row).select('*').single();
  if (error) throw error;
  await allocatePayment(data.id, req);
  await writeAudit(req, 'insert', 'afc_payments', data.id, null, data, 'To‘lov kiritildi');
  res.json({ payment: data });
}));

app.get('/api/payments', auth, asyncRoute(async (req, res) => {
  let q = supabase.from('afc_payments').select('*, afc_companies(name)').order('payment_date', { ascending: false }).limit(500);
  if (req.query.period_id) q = q.eq('period_id', req.query.period_id);
  if (req.query.company_id) q = q.eq('company_id', req.query.company_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ payments: data || [] });
}));

app.put('/api/payments/:id', auth, requireWrite, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_payments').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  const body = req.body || {};
  await assertPeriodOpen(body.period_id);
  const row = { company_id: body.company_id, period_id: body.period_id, payment_date: body.payment_date, payment_type: body.payment_type || 'naqd', amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), payment_scope: body.payment_scope || 'avval eski qarzlar, keyin joriy oy', comment: body.comment || '' };
  const { data, error } = await supabase.from('afc_payments').update(row).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await allocatePayment(data.id, req);
  await writeAudit(req, 'update', 'afc_payments', data.id, before, data, 'To‘lov tahrirlandi');
  res.json({ payment: data });
}));

app.delete('/api/payments/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_payments').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  await supabase.from('afc_payment_allocations').delete().eq('payment_id', req.params.id);
  const { error } = await supabase.from('afc_payments').delete().eq('id', req.params.id);
  if (error) throw error;
  await writeAudit(req, 'delete', 'afc_payments', req.params.id, before, null, 'To‘lov o‘chirildi');
  res.json({ ok: true });
}));

app.post('/api/services', auth, requireWrite, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.company_id || !body.period_id || !body.service_name) return res.status(400).json({ error: 'Korxona, davr va xizmat nomi majburiy' });
  await assertPeriodOpen(body.period_id);
  const row = { company_id: body.company_id, period_id: body.period_id, service_date: body.service_date || new Date().toISOString().slice(0, 10), service_name: body.service_name, amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), comment: body.comment || '', created_by: req.user.id };
  const { data, error } = await supabase.from('afc_services').insert(row).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'insert', 'afc_services', data.id, null, data, 'Qo‘shimcha xizmat qo‘shildi');
  res.json({ service: data });
}));

app.get('/api/services', auth, asyncRoute(async (req, res) => {
  let q = supabase.from('afc_services').select('*, afc_companies(name)').order('service_date', { ascending: false }).limit(500);
  if (req.query.period_id) q = q.eq('period_id', req.query.period_id);
  if (req.query.company_id) q = q.eq('company_id', req.query.company_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ services: data || [] });
}));

app.put('/api/services/:id', auth, requireWrite, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_services').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  const body = req.body || {};
  await assertPeriodOpen(body.period_id);
  const row = { company_id: body.company_id, period_id: body.period_id, service_date: body.service_date || new Date().toISOString().slice(0, 10), service_name: body.service_name, amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), comment: body.comment || '' };
  const { data, error } = await supabase.from('afc_services').update(row).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'update', 'afc_services', req.params.id, before, data, 'Qo‘shimcha xizmat tahrirlandi');
  res.json({ service: data });
}));

app.delete('/api/services/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_services').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  const { error } = await supabase.from('afc_services').delete().eq('id', req.params.id);
  if (error) throw error;
  await writeAudit(req, 'delete', 'afc_services', req.params.id, before, null, 'Qo‘shimcha xizmat o‘chirildi');
  res.json({ ok: true });
}));

app.post('/api/expenses', auth, requireWrite, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.period_id || !body.expense_date || !body.expense_type) return res.status(400).json({ error: 'Davr, sana va xarajat turi majburiy' });
  await assertPeriodOpen(body.period_id);
  const row = { period_id: body.period_id, expense_date: body.expense_date, expense_type: body.expense_type, paid_to: body.paid_to || '', payment_type: body.payment_type || 'naqd', amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), comment: body.comment || '', created_by: req.user.id };
  const { data, error } = await supabase.from('afc_expenses').insert(row).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'insert', 'afc_expenses', data.id, null, data, 'Xarajat kiritildi');
  res.json({ expense: data });
}));

app.get('/api/expenses', auth, asyncRoute(async (req, res) => {
  let q = supabase.from('afc_expenses').select('*').order('expense_date', { ascending: false }).limit(500);
  if (req.query.period_id) q = q.eq('period_id', req.query.period_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ expenses: data || [] });
}));

app.put('/api/expenses/:id', auth, requireWrite, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_expenses').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  const body = req.body || {};
  await assertPeriodOpen(body.period_id);
  const row = { period_id: body.period_id, expense_date: body.expense_date, expense_type: body.expense_type, paid_to: body.paid_to || '', payment_type: body.payment_type || 'naqd', amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate), amount_usd: n(body.amount_usd), exchange_rate: n(body.exchange_rate), comment: body.comment || '' };
  const { data, error } = await supabase.from('afc_expenses').update(row).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  await writeAudit(req, 'update', 'afc_expenses', req.params.id, before, data, 'Xarajat tahrirlandi');
  res.json({ expense: data });
}));

app.delete('/api/expenses/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before, error: beforeError } = await supabase.from('afc_expenses').select('*').eq('id', req.params.id).single();
  if (beforeError) throw beforeError;
  await assertPeriodOpen(before.period_id);
  const { error } = await supabase.from('afc_expenses').delete().eq('id', req.params.id);
  if (error) throw error;
  await writeAudit(req, 'delete', 'afc_expenses', req.params.id, before, null, 'Xarajat o‘chirildi');
  res.json({ ok: true });
}));

app.get('/api/users', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('afc_users').select('id,login,full_name,role,is_active,created_at,updated_at').order('created_at', { ascending: false });
  if (error) throw error;
  res.json({ users: data || [] });
}));

app.post('/api/users', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { login, password, full_name, role, is_active } = req.body || {};
  if (!login || !password) return res.status(400).json({ error: 'Login va parol majburiy' });
  const password_hash = await bcrypt.hash(password, 10);
  const row = { login, password_hash, full_name: full_name || login, role: ['admin', 'operator', 'viewer'].includes(role) ? role : 'viewer', is_active: is_active !== 'false' && is_active !== false };
  const { data, error } = await supabase.from('afc_users').insert(row).select('id,login,full_name,role,is_active,created_at').single();
  if (error) throw error;
  await writeAudit(req, 'insert', 'afc_users', data.id, null, data, 'Foydalanuvchi yaratildi');
  res.json({ user: data });
}));

app.put('/api/users/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data: before } = await supabase.from('afc_users').select('id,login,full_name,role,is_active').eq('id', req.params.id).single();
  const body = req.body || {};
  const row = { login: body.login, full_name: body.full_name || '', role: ['admin', 'operator', 'viewer'].includes(body.role) ? body.role : 'viewer', is_active: body.is_active !== 'false' && body.is_active !== false, updated_at: new Date().toISOString() };
  if (body.password) row.password_hash = await bcrypt.hash(body.password, 10);
  const { data, error } = await supabase.from('afc_users').update(row).eq('id', req.params.id).select('id,login,full_name,role,is_active,updated_at').single();
  if (error) throw error;
  await writeAudit(req, 'update', 'afc_users', req.params.id, before, data, 'Foydalanuvchi tahrirlandi');
  res.json({ user: data });
}));

app.get('/api/audit-logs', auth, requireAdmin, asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const { data, error } = await supabase.from('afc_audit_logs').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  res.json({ logs: data || [] });
}));


app.get('/api/archive', auth, requireAdmin, asyncRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 300), 1000);
  const [archivedCompanies, records, logs] = await Promise.all([
    dbList('afc_companies', '*', { column: 'updated_at', ascending: false }).then(rows => rows.filter(r => r.status === 'archived')),
    dbList('afc_archive_records', '*', { column: 'created_at', ascending: false }, true).then(rows => rows.slice(0, limit)),
    dbList('afc_audit_logs', '*', { column: 'created_at', ascending: false }, true).then(rows => rows.slice(0, limit))
  ]);
  res.json({ archived_companies: archivedCompanies, records, logs });
}));

app.get('/api/archive/records/:id', auth, requireAdmin, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('afc_archive_records').select('*').eq('id', req.params.id).single();
  if (error) throw error;
  res.json({ record: data });
}));

app.get('/api/export/json', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  const archiveRecords = await dbList('afc_archive_records', '*', { column: 'created_at', ascending: false }, true);
  const auditLogs = await dbList('afc_audit_logs', '*', { column: 'created_at', ascending: false }, true);
  res.json({ exported_at: new Date().toISOString(), ...data, archiveRecords, auditLogs });
}));

function csvEscape(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }
function sendCsv(res, filename, headers, rows) {
  const csv = '\ufeff' + [headers.map(csvEscape).join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}

app.get('/api/export/monthly.csv', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  const dash = buildDashboard(req.query.period_id, data);
  const headers = ['Korxona','STIR','Rahbar','Telefon','Korxona statusi','Davr statusi','Ish haqi hisoblandi','Ish haqi','Qo‘shimcha xizmat','Davr boshidagi qarz','Hisoblangan','Joriy to‘langan','Eski qarz hisobda','Joriy qarz','Jami qarz','Holat'];
  const rows = (dash.companies || []).map(r => ({
    'Korxona': r.company_name, 'STIR': r.stir, 'Rahbar': r.director_name, 'Telefon': r.phone,
    'Korxona statusi': r.company_status_label, 'Davr statusi': r.period_status_label, 'Ish haqi hisoblandi': r.salary_enabled ? 'ha' : 'yo‘q',
    'Ish haqi': r.salary_sum, 'Qo‘shimcha xizmat': r.services_sum, 'Davr boshidagi qarz': r.opening_debt_sum,
    'Hisoblangan': r.charged_sum, 'Joriy to‘langan': r.paid_to_current_sum, 'Eski qarz hisobda': r.previous_debt,
    'Joriy qarz': r.current_debt, 'Jami qarz': r.total_debt, 'Holat': r.status
  }));
  sendCsv(res, `all_finance_cash_${dash.selected_period?.period_name || 'monthly'}.csv`, headers, rows);
}));

app.get('/api/export/companies.csv', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  const headers = ['name','stir','director_name','phone','status','salary_sum','salary_usd','exchange_rate','effective_from','opening_debt_sum','opening_debt_usd','opening_debt_rate','opening_debt_comment'];
  const periods = data.periods.sort(comparePeriodAsc);
  const latestPeriod = periods.at(-1);
  const rows = data.companies.filter(c => c.status !== 'archived').map(c => {
    const salary = latestPeriod ? activeSalaryForPeriod(c.id, latestPeriod, data.salaryRates) : {};
    return { name: c.name, stir: c.stir, director_name: c.director_name, phone: c.phone, status: c.status || 'active', salary_sum: salary.amount_sum || 0, salary_usd: salary.amount_usd || 0, exchange_rate: salary.exchange_rate || 0, effective_from: salary.effective_from || '', opening_debt_sum: '', opening_debt_usd: '', opening_debt_rate: '', opening_debt_comment: '' };
  });
  sendCsv(res, 'all_finance_cash_companies_template.csv', headers, rows);
}));

app.post('/api/import/companies', auth, requireAdmin, asyncRoute(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const periodId = req.body.period_id || null;
  if (!rows.length) return res.status(400).json({ error: 'Import uchun qatorlar topilmadi' });
  if (periodId) await assertPeriodOpen(periodId);
  let created = 0, updated = 0, salaryRates = 0, openingDebts = 0;
  const errors = [];
  for (const [idx, raw] of rows.entries()) {
    try {
      const name = raw.name || raw.Korxona || raw['Korxona nomi'];
      if (!name) continue;
      const stir = raw.stir || raw.STIR || '';
      let company = null;
      if (stir) {
        const { data } = await supabase.from('afc_companies').select('*').eq('stir', String(stir)).neq('status', 'archived').maybeSingle();
        company = data;
      }
      if (!company) {
        const { data } = await supabase.from('afc_companies').select('*').eq('name', name).neq('status', 'archived').maybeSingle();
        company = data;
      }
      const companyRow = { name, stir, director_name: raw.director_name || raw.Rahbar || '', phone: raw.phone || raw.Telefon || '', note: raw.note || '', status: raw.status || raw.Status || 'active', updated_at: new Date().toISOString() };
      if (company) {
        const { data, error } = await supabase.from('afc_companies').update(companyRow).eq('id', company.id).select('*').single();
        if (error) throw error; company = data; updated++;
      } else {
        const { data, error } = await supabase.from('afc_companies').insert(companyRow).select('*').single();
        if (error) throw error; company = data; created++;
      }
      const salaryAmount = moneyFromInputs(raw.salary_sum || raw['Ish haqi'], raw.salary_usd, raw.exchange_rate);
      if (salaryAmount > 0 || n(raw.salary_usd) > 0) {
        const { error } = await supabase.from('afc_salary_rates').insert({ company_id: company.id, amount_sum: salaryAmount, amount_usd: n(raw.salary_usd), exchange_rate: n(raw.exchange_rate), effective_from: raw.effective_from || new Date().toISOString().slice(0,10), note: raw.salary_note || 'Excel/CSV import orqali kiritildi', created_by: req.user.id });
        if (error) throw error; salaryRates++;
      }
      const debtAmount = moneyFromInputs(raw.opening_debt_sum, raw.opening_debt_usd, raw.opening_debt_rate || raw.exchange_rate);
      if (periodId && debtAmount > 0) {
        const { error } = await supabase.from('afc_opening_debts').insert({ company_id: company.id, period_id: periodId, debt_date: raw.debt_date || periodStart((await getAllData()).periods.find(p => p.id === periodId) || {year: new Date().getFullYear(), month: new Date().getMonth()+1}), amount_sum: debtAmount, amount_usd: n(raw.opening_debt_usd), exchange_rate: n(raw.opening_debt_rate || raw.exchange_rate), comment: raw.opening_debt_comment || 'Import qilingan davr boshidagi qarz', created_by: req.user.id });
        if (error) throw error; openingDebts++;
      }
    } catch (e) {
      errors.push({ row: idx + 1, error: e.message });
    }
  }
  await writeAudit(req, 'import', 'afc_companies', null, null, { created, updated, salaryRates, openingDebts, errors }, 'Korxonalar CSV import qilindi');
  res.json({ created, updated, salary_rates: salaryRates, opening_debts: openingDebts, errors });
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API topilmadi' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server xatosi' });
});

app.listen(PORT, () => console.log(`ALL FINANCE CASH running on port ${PORT}`));
