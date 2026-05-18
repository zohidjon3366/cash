require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 10000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const ADMIN_SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. API will not work until ENV is configured.');
}

const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_SERVICE_ROLE_KEY || 'missing', {
  auth: { persistSession: false, autoRefreshToken: false }
});

const app = express();
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: false
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

const corsOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || corsOrigins.includes('*') || corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, true); // iframe/Tilda uchun yumshoq rejim; productionda domenni aniq yozing
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

function n(value) {
  const num = Number(String(value ?? 0).replace(/\s/g, '').replace(/,/g, '.'));
  return Number.isFinite(num) ? num : 0;
}

function moneyFromInputs(amountSum, amountUsd, exchangeRate) {
  const sum = n(amountSum);
  const usd = n(amountUsd);
  const rate = n(exchangeRate);
  if (sum > 0) return sum;
  if (usd > 0 && rate > 0) return Math.round(usd * rate * 100) / 100;
  return 0;
}

function monthNameUz(month) {
  const names = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
  return names[Number(month) - 1] || String(month);
}

function periodLabel(year, month) {
  return `${monthNameUz(month)} ${year}`;
}

function dateOnly(d) {
  if (!d) return null;
  return String(d).slice(0, 10);
}

function periodStart(period) {
  return `${period.year}-${String(period.month).padStart(2, '0')}-01`;
}

function periodEnd(period) {
  const y = Number(period.year);
  const m = Number(period.month);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period.year}-${String(period.month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function ymKey(p) {
  return Number(p.year) * 100 + Number(p.month);
}

function comparePeriodAsc(a, b) {
  return ymKey(a) - ymKey(b);
}

function normalizeRowAmounts(row) {
  const rate = n(row.exchange_rate);
  const amountSum = moneyFromInputs(row.amount_sum, row.amount_usd, row.exchange_rate);
  return { ...row, amount_sum: amountSum, amount_usd: n(row.amount_usd), exchange_rate: rate };
}

async function dbList(table, select = '*', order = null) {
  let q = supabase.from(table).select(select);
  if (order) q = q.order(order.column, { ascending: order.ascending ?? true });
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getAllData() {
  const [companies, periods, salaryRates, payments, expenses, services] = await Promise.all([
    dbList('afc_companies', '*', { column: 'created_at', ascending: true }),
    dbList('afc_periods', '*', { column: 'year', ascending: false }),
    dbList('afc_salary_rates', '*', { column: 'effective_from', ascending: true }),
    dbList('afc_payments', '*', { column: 'payment_date', ascending: false }),
    dbList('afc_expenses', '*', { column: 'expense_date', ascending: false }),
    dbList('afc_services', '*', { column: 'service_date', ascending: false })
  ]);
  return { companies, periods, salaryRates, payments, expenses, services };
}

function activeSalaryForPeriod(companyId, period, salaryRates) {
  const end = periodEnd(period);
  const rates = salaryRates
    .filter(r => r.company_id === companyId && dateOnly(r.effective_from) <= end)
    .sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)) || String(a.created_at).localeCompare(String(b.created_at)));
  const rate = rates[rates.length - 1];
  if (!rate) return { amount_sum: 0, amount_usd: 0, exchange_rate: 0, effective_from: null, note: '' };
  const amountSum = moneyFromInputs(rate.amount_sum, rate.amount_usd, rate.exchange_rate);
  return {
    ...rate,
    amount_sum: amountSum,
    amount_usd: n(rate.amount_usd),
    exchange_rate: n(rate.exchange_rate)
  };
}

function chargedForCompanyPeriod(companyId, periodId, period, salaryRates, services) {
  const salary = activeSalaryForPeriod(companyId, period, salaryRates);
  const serviceList = services.filter(s => s.company_id === companyId && s.period_id === periodId);
  const servicesSum = serviceList.reduce((acc, s) => acc + moneyFromInputs(s.amount_sum, s.amount_usd, s.exchange_rate), 0);
  const servicesUsd = serviceList.reduce((acc, s) => acc + n(s.amount_usd), 0);
  return {
    salary_sum: n(salary.amount_sum),
    salary_usd: n(salary.amount_usd),
    salary_rate: salary,
    services_sum: servicesSum,
    services_usd: servicesUsd,
    charged_sum: n(salary.amount_sum) + servicesSum,
    service_count: serviceList.length
  };
}

function paidForCompanyPeriod(companyId, periodId, payments) {
  const list = payments.filter(p => p.company_id === companyId && p.period_id === periodId);
  return {
    paid_sum: list.reduce((acc, p) => acc + moneyFromInputs(p.amount_sum, p.amount_usd, p.exchange_rate), 0),
    paid_usd: list.reduce((acc, p) => acc + n(p.amount_usd), 0),
    payment_count: list.length
  };
}

function companyPeriodBalance(companyId, period, data) {
  const charged = chargedForCompanyPeriod(companyId, period.id, period, data.salaryRates, data.services);
  const paid = paidForCompanyPeriod(companyId, period.id, data.payments);
  const balance = charged.charged_sum - paid.paid_sum;
  return {
    ...charged,
    ...paid,
    balance_sum: balance,
    debt_sum: Math.max(balance, 0),
    overpaid_sum: Math.max(-balance, 0)
  };
}

function statusFromAmounts(charged, paid, totalDebt) {
  if (charged <= 0 && paid <= 0) return 'hisoblanmagan';
  if (totalDebt <= 0 && paid >= charged) return 'toliq berilgan';
  if (paid <= 0) return 'berilmagan';
  if (paid > 0 && totalDebt > 0) return 'qisman berilgan';
  return 'qoldiq mavjud';
}

function buildDashboard(selectedPeriodId, data) {
  let periods = [...data.periods].sort(comparePeriodAsc);
  const selectedPeriod = data.periods.find(p => p.id === selectedPeriodId) || periods[periods.length - 1];
  if (!selectedPeriod) {
    return { empty: true, message: 'Avval oy yarating' };
  }
  const selectedKey = ymKey(selectedPeriod);
  const priorPeriods = periods.filter(p => ymKey(p) < selectedKey);

  const companyRows = data.companies
    .filter(c => c.status !== 'archived')
    .map(company => {
      const current = companyPeriodBalance(company.id, selectedPeriod, data);
      const oldDebtItems = priorPeriods.map(p => {
        const b = companyPeriodBalance(company.id, p, data);
        return {
          period_id: p.id,
          period_name: p.period_name || periodLabel(p.year, p.month),
          charged_sum: b.charged_sum,
          paid_sum: b.paid_sum,
          debt_sum: b.debt_sum,
          salary_sum: b.salary_sum,
          services_sum: b.services_sum
        };
      }).filter(item => item.debt_sum > 0.001);
      const previousDebt = oldDebtItems.reduce((acc, it) => acc + it.debt_sum, 0);
      const totalDebt = previousDebt + current.debt_sum;
      return {
        company_id: company.id,
        company_name: company.name,
        stir: company.stir,
        director_name: company.director_name,
        phone: company.phone,
        salary_sum: current.salary_sum,
        salary_usd: current.salary_usd,
        services_sum: current.services_sum,
        service_count: current.service_count,
        charged_sum: current.charged_sum,
        paid_sum: current.paid_sum,
        current_debt: current.debt_sum,
        previous_debt: previousDebt,
        total_debt: totalDebt,
        overpaid_sum: current.overpaid_sum,
        status: statusFromAmounts(current.charged_sum, current.paid_sum, totalDebt),
        salary_effective_from: current.salary_rate.effective_from,
        old_debt_items: oldDebtItems
      };
    });

  const periodExpenses = data.expenses.filter(e => e.period_id === selectedPeriod.id)
    .map(normalizeRowAmounts);
  const periodPayments = data.payments.filter(p => p.period_id === selectedPeriod.id)
    .map(normalizeRowAmounts);
  const periodServices = data.services.filter(s => s.period_id === selectedPeriod.id)
    .map(normalizeRowAmounts);

  const totalCharged = companyRows.reduce((acc, r) => acc + r.charged_sum, 0);
  const totalSalary = companyRows.reduce((acc, r) => acc + r.salary_sum, 0);
  const totalService = companyRows.reduce((acc, r) => acc + r.services_sum, 0);
  const totalPaid = periodPayments.reduce((acc, p) => acc + p.amount_sum, 0);
  const totalExpenses = periodExpenses.reduce((acc, e) => acc + e.amount_sum, 0);
  const totalDebt = companyRows.reduce((acc, r) => acc + r.total_debt, 0);
  const oldDebt = companyRows.reduce((acc, r) => acc + r.previous_debt, 0);
  const currentDebt = companyRows.reduce((acc, r) => acc + r.current_debt, 0);

  const periodsForChart = periods.filter(p => ymKey(p) <= selectedKey).slice(-6);
  const chart = periodsForChart.map(p => {
    const rowsForP = data.companies.filter(c => c.status !== 'archived').map(c => companyPeriodBalance(c.id, p, data));
    const income = rowsForP.reduce((acc, r) => acc + r.charged_sum, 0);
    const pay = data.payments.filter(x => x.period_id === p.id).reduce((acc, x) => acc + moneyFromInputs(x.amount_sum, x.amount_usd, x.exchange_rate), 0);
    const exp = data.expenses.filter(x => x.period_id === p.id).reduce((acc, x) => acc + moneyFromInputs(x.amount_sum, x.amount_usd, x.exchange_rate), 0);
    return { label: monthNameUz(p.month).slice(0, 3), income, paid: pay, expenses: exp, profit: pay - exp };
  });

  const companyById = new Map(data.companies.map(c => [c.id, c]));
  const latestPayments = [...periodPayments]
    .sort((a, b) => String(b.payment_date).localeCompare(String(a.payment_date)))
    .slice(0, 5)
    .map(p => ({ ...p, company_name: companyById.get(p.company_id)?.name || 'Korxona' }));
  const latestExpenses = [...periodExpenses]
    .sort((a, b) => String(b.expense_date).localeCompare(String(a.expense_date)))
    .slice(0, 5);
  const latestServices = [...periodServices]
    .sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)))
    .slice(0, 5)
    .map(s => ({ ...s, company_name: companyById.get(s.company_id)?.name || 'Korxona' }));

  return {
    empty: false,
    selected_period: selectedPeriod,
    periods: data.periods.sort((a, b) => ymKey(b) - ymKey(a)),
    totals: {
      total_salary: totalSalary,
      total_services: totalService,
      total_charged: totalCharged,
      total_paid: totalPaid,
      total_expenses: totalExpenses,
      calculated_profit: totalCharged - totalExpenses,
      real_profit: totalPaid - totalExpenses,
      total_debt: totalDebt,
      old_debt: oldDebt,
      current_debt: currentDebt,
      companies_count: companyRows.length
    },
    companies: companyRows.sort((a, b) => b.total_debt - a.total_debt || a.company_name.localeCompare(b.company_name)),
    latest_payments: latestPayments,
    latest_expenses: latestExpenses,
    latest_services: latestServices,
    chart
  };
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'ALL FINANCE CASH', time: new Date().toISOString() }));

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

app.post('/api/periods', auth, asyncRoute(async (req, res) => {
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'Yil va oy noto‘g‘ri' });
  const row = {
    year,
    month,
    period_name: req.body.period_name || periodLabel(year, month),
    default_usd_rate: n(req.body.default_usd_rate),
    is_closed: false
  };
  const { data, error } = await supabase.from('afc_periods').upsert(row, { onConflict: 'year,month' }).select('*').single();
  if (error) throw error;
  res.json({ period: data });
}));

app.get('/api/dashboard', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  const dashboard = buildDashboard(req.query.period_id, data);
  res.json(dashboard);
}));

app.get('/api/companies', auth, asyncRoute(async (req, res) => {
  const { data, error } = await supabase.from('afc_companies').select('*').order('name', { ascending: true });
  if (error) throw error;
  res.json({ companies: data || [] });
}));

app.post('/api/companies', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'Korxona nomi majburiy' });
  const companyRow = {
    name: body.name,
    stir: body.stir || '',
    director_name: body.director_name || '',
    phone: body.phone || '',
    note: body.note || '',
    status: 'active'
  };
  const { data: company, error } = await supabase.from('afc_companies').insert(companyRow).select('*').single();
  if (error) throw error;
  const salary = {
    company_id: company.id,
    amount_sum: moneyFromInputs(body.salary_sum, body.salary_usd, body.exchange_rate),
    amount_usd: n(body.salary_usd),
    exchange_rate: n(body.exchange_rate),
    effective_from: body.effective_from || new Date().toISOString().slice(0, 10),
    note: body.salary_note || 'Boshlang‘ich ish haqi summasi',
    created_by: req.user.id
  };
  const { error: salaryError } = await supabase.from('afc_salary_rates').insert(salary);
  if (salaryError) throw salaryError;
  res.json({ company });
}));

app.put('/api/companies/:id', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const row = {
    name: body.name,
    stir: body.stir || '',
    director_name: body.director_name || '',
    phone: body.phone || '',
    note: body.note || '',
    updated_at: new Date().toISOString()
  };
  const { data, error } = await supabase.from('afc_companies').update(row).eq('id', req.params.id).select('*').single();
  if (error) throw error;
  res.json({ company: data });
}));

app.post('/api/companies/:id/salary-rate', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.effective_from) return res.status(400).json({ error: 'Qaysi sanadan amal qilishi majburiy' });
  if (!body.note) return res.status(400).json({ error: 'O‘zgarish izohi majburiy' });
  const row = {
    company_id: req.params.id,
    amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate),
    amount_usd: n(body.amount_usd),
    exchange_rate: n(body.exchange_rate),
    effective_from: body.effective_from,
    note: body.note,
    created_by: req.user.id
  };
  const { data, error } = await supabase.from('afc_salary_rates').insert(row).select('*').single();
  if (error) throw error;
  res.json({ salary_rate: data });
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
    return {
      period_id: p.id,
      period_name: p.period_name || periodLabel(p.year, p.month),
      salary_sum: b.salary_sum,
      services_sum: b.services_sum,
      charged_sum: b.charged_sum,
      paid_sum: b.paid_sum,
      debt_sum: b.debt_sum
    };
  }).filter(i => i.debt_sum > 0.001);
  res.json({ items });
}));

app.post('/api/payments', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.company_id || !body.period_id || !body.payment_date) return res.status(400).json({ error: 'Korxona, davr va to‘lov sanasi majburiy' });
  const row = {
    company_id: body.company_id,
    period_id: body.period_id,
    payment_date: body.payment_date,
    payment_type: body.payment_type || 'naqd',
    amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate),
    amount_usd: n(body.amount_usd),
    exchange_rate: n(body.exchange_rate),
    payment_scope: body.payment_scope || 'umumiy qarz',
    comment: body.comment || '',
    created_by: req.user.id
  };
  const { data, error } = await supabase.from('afc_payments').insert(row).select('*').single();
  if (error) throw error;
  res.json({ payment: data });
}));

app.get('/api/payments', auth, asyncRoute(async (req, res) => {
  let q = supabase.from('afc_payments').select('*, afc_companies(name)').order('payment_date', { ascending: false }).limit(300);
  if (req.query.period_id) q = q.eq('period_id', req.query.period_id);
  if (req.query.company_id) q = q.eq('company_id', req.query.company_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ payments: data || [] });
}));

app.post('/api/services', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.company_id || !body.period_id || !body.service_name) return res.status(400).json({ error: 'Korxona, davr va xizmat nomi majburiy' });
  const row = {
    company_id: body.company_id,
    period_id: body.period_id,
    service_date: body.service_date || new Date().toISOString().slice(0, 10),
    service_name: body.service_name,
    amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate),
    amount_usd: n(body.amount_usd),
    exchange_rate: n(body.exchange_rate),
    comment: body.comment || '',
    created_by: req.user.id
  };
  const { data, error } = await supabase.from('afc_services').insert(row).select('*').single();
  if (error) throw error;
  res.json({ service: data });
}));

app.get('/api/services', auth, asyncRoute(async (req, res) => {
  let q = supabase.from('afc_services').select('*, afc_companies(name)').order('service_date', { ascending: false }).limit(300);
  if (req.query.period_id) q = q.eq('period_id', req.query.period_id);
  if (req.query.company_id) q = q.eq('company_id', req.query.company_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ services: data || [] });
}));

app.post('/api/expenses', auth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.period_id || !body.expense_date || !body.expense_type) return res.status(400).json({ error: 'Davr, sana va xarajat turi majburiy' });
  const row = {
    period_id: body.period_id,
    expense_date: body.expense_date,
    expense_type: body.expense_type,
    paid_to: body.paid_to || '',
    payment_type: body.payment_type || 'naqd',
    amount_sum: moneyFromInputs(body.amount_sum, body.amount_usd, body.exchange_rate),
    amount_usd: n(body.amount_usd),
    exchange_rate: n(body.exchange_rate),
    comment: body.comment || '',
    created_by: req.user.id
  };
  const { data, error } = await supabase.from('afc_expenses').insert(row).select('*').single();
  if (error) throw error;
  res.json({ expense: data });
}));

app.get('/api/expenses', auth, asyncRoute(async (req, res) => {
  let q = supabase.from('afc_expenses').select('*').order('expense_date', { ascending: false }).limit(300);
  if (req.query.period_id) q = q.eq('period_id', req.query.period_id);
  const { data, error } = await q;
  if (error) throw error;
  res.json({ expenses: data || [] });
}));

app.get('/api/export/json', auth, asyncRoute(async (req, res) => {
  const data = await getAllData();
  res.json({ exported_at: new Date().toISOString(), ...data });
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API topilmadi' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server xatosi' });
});

app.listen(PORT, () => {
  console.log(`ALL FINANCE CASH running on port ${PORT}`);
});
