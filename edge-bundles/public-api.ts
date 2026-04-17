// Auto-bundled by deploy script
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// === INLINED: _shared/cors.ts ===
// Shared CORS headers for all Edge Functions
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  return null;
}


// === INLINED: _shared/response.ts ===


function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function errorResponse(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function unauthorizedResponse() {
  return errorResponse('Não autorizado', 401);
}

function forbiddenResponse() {
  return errorResponse('Sem permissão para esta ação', 403);
}

// Helper: parsear query params de paginação
function parsePagination(url: URL) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '20')));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// Helper: parsear query params de busca
function parseSearch(url: URL) {
  return url.searchParams.get('q')?.trim() || '';
}

// Helper: audit log
async function logAudit(
  adminClient: any,
  userId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  oldData?: unknown,
  newData?: unknown
) {
  await adminClient.from('audit_log').insert({
    user_id: userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    old_data: oldData || null,
    new_data: newData || null,
  });
}


// === INLINED: _shared/supabase.ts ===


// Client autenticado (respeita RLS com JWT do usuário)
function getSupabaseClient(req: Request) {
  const authHeader = req.headers.get('Authorization')!;
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );
}

// Client admin (ignora RLS, para operações de sistema)
function getSupabaseAdmin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
}

// Helper: Extrair user ID do JWT
async function getUserId(req: Request): Promise<string | null> {
  const supabase = getSupabaseClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

// Helper: Checar role do usuário
async function getUserRole(req: Request): Promise<'admin' | 'operador' | null> {
  const userId = await getUserId(req);
  if (!userId) return null;
  const admin = getSupabaseAdmin();
  const { data } = await admin.from('profiles').select('role').eq('id', userId).single();
  return data?.role ?? null;
}

// Helper: Verificar se é admin
async function requireAdmin(req: Request): Promise<boolean> {
  const role = await getUserRole(req);
  return role === 'admin';
}

// Helper: Verificar se é staff (admin ou operador)
async function requireStaff(req: Request): Promise<boolean> {
  const role = await getUserRole(req);
  return role === 'admin' || role === 'operador';
}


// === FUNCTION BODY ===
// Edge Function: /public-api
// Endpoints públicos (catálogo) + endpoints autenticados (dados do cliente)

// Helper: extrair e validar o customer autenticado via JWT
async function getAuthenticatedCustomer(req: Request): Promise<{ id: string; [key: string]: any } | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  try {
    const supabaseAuth = getSupabaseClient(req);
    const { data: { user }, error } = await supabaseAuth.auth.getUser();
    if (error || !user) return null;

    const admin = getSupabaseAdmin();
    const { data: customer } = await admin
      .from('customers')
      .select('*')
      .eq('auth_user_id', user.id)
      .eq('is_active', true)
      .single();

    return customer || null;
  } catch {
    return null;
  }
}


serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseAdmin();

  // ══════════════════════════════════════════
  // ENDPOINTS PÚBLICOS (sem autenticação)
  // ══════════════════════════════════════════

  // ─── GET /public-api/prizes ─── Prêmios ativos para a loja
  if (method === 'GET' && url.pathname.includes('/prizes')) {
    const category = url.searchParams.get('category');
    const tier = url.searchParams.get('tier') || 'basic';

    let query = supabase
      .from('prizes')
      .select('id, name, description, type, points_required, image_url, min_tier, prize_categories(name, slug, icon)')
      .eq('is_active', true)
      .order('points_required');

    if (category) {
      const { data: cat } = await supabase.from('prize_categories').select('id').eq('slug', category).single();
      if (cat) query = query.eq('category_id', cat.id);
    }

    const { data, error } = await query;
    if (error) return errorResponse(error.message);

    const tierOrder = ['basic', 'gold', 'platinum', 'prime', 'select'];
    const tierIdx = tierOrder.indexOf(tier);
    const filtered = (data || []).filter(p => tierOrder.indexOf(p.min_tier || 'basic') <= tierIdx);

    return jsonResponse(filtered);
  }

  // ─── GET /public-api/categories ─── Categorias de prêmios
  if (method === 'GET' && url.pathname.includes('/categories')) {
    const { data, error } = await supabase
      .from('prize_categories')
      .select('id, name, slug, icon, sort_order')
      .eq('is_active', true)
      .order('sort_order');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── GET /public-api/tiers ─── Informações dos tiers
  if (method === 'GET' && url.pathname.includes('/tiers')) {
    const { data, error } = await supabase
      .from('customer_categories')
      .select('name, tier, min_points, max_points, multiplier, color, icon, benefits')
      .eq('is_active', true)
      .order('min_points');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── GET /public-api/settings ─── Configurações públicas
  if (method === 'GET' && url.pathname.includes('/settings')) {
    const publicKeys = ['program_name', 'points_name', 'company_name', 'company_logo', 'primary_color', 'accent_color', 'support_email'];

    const { data, error } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', publicKeys);

    if (error) return errorResponse(error.message);

    const settings: Record<string, any> = {};
    (data || []).forEach(s => { settings[s.key] = s.value; });
    return jsonResponse(settings);
  }

  // ══════════════════════════════════════════
  // ENDPOINTS PROTEGIDOS (exigem JWT válido)
  // ══════════════════════════════════════════

  // ─── GET /public-api/customer/me ─── Perfil do cliente autenticado
  if (method === 'GET' && url.pathname.includes('/customer/me') && !url.pathname.includes('/points') && !url.pathname.includes('/redemptions')) {
    const customer = await getAuthenticatedCustomer(req);
    if (!customer) return unauthorizedResponse();

    const { auth_user_id, needs_password_change, ...safeData } = customer;
    return jsonResponse(safeData);
  }

  // ─── GET /public-api/customer/me/points ─── Extrato de pontos (autenticado)
  if (method === 'GET' && url.pathname.includes('/customer/') && url.pathname.includes('/points')) {
    const customer = await getAuthenticatedCustomer(req);
    if (!customer) return unauthorizedResponse();

    const { data, error } = await supabase
      .from('point_transactions')
      .select('id, type, points, description, created_at, point_rules(name)')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── GET /public-api/customer/me/redemptions ─── Resgates (autenticado)
  if (method === 'GET' && url.pathname.includes('/customer/') && url.pathname.includes('/redemptions')) {
    const customer = await getAuthenticatedCustomer(req);
    if (!customer) return unauthorizedResponse();

    const { data, error } = await supabase
      .from('redemptions')
      .select('id, status, points_spent, created_at, prizes(name, image_url)')
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false });

    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── POST /public-api/customer/me/redeem ─── Resgatar prêmio (autenticado)
  if (method === 'POST' && url.pathname.includes('/redeem')) {
    const customer = await getAuthenticatedCustomer(req);
    if (!customer) return unauthorizedResponse();

    const body = await req.json();
    if (!body.prize_id) return errorResponse('prize_id obrigatório');

    const { data: prize } = await supabase.from('prizes').select('*').eq('id', body.prize_id).eq('is_active', true).single();
    if (!prize) return errorResponse('Prêmio não disponível', 404);
    if (prize.stock !== null && prize.stock <= 0) return errorResponse('Sem estoque');

    if (customer.available_points < prize.points_required) return errorResponse('Saldo insuficiente');

    const tierOrder = ['basic', 'gold', 'platinum', 'prime', 'select'];
    if (tierOrder.indexOf(customer.tier) < tierOrder.indexOf(prize.min_tier || 'basic')) {
      return errorResponse(`Tier mínimo: ${prize.min_tier}`);
    }

    await supabase.from('point_transactions').insert({
      customer_id: customer.id,
      type: 'debit',
      points: -prize.points_required,
      description: `Resgate: ${prize.name}`,
    });

    const { data, error } = await supabase.from('redemptions').insert({
      customer_id: customer.id,
      prize_id: body.prize_id,
      points_spent: prize.points_required,
    }).select('*, prizes(name)').single();

    if (error) return errorResponse(error.message);
    return jsonResponse(data, 201);
  }

  // ─── POST /public-api/survey/:id/respond ─── Responder pesquisa (autenticado)
  if (method === 'POST' && url.pathname.includes('/survey/') && url.pathname.includes('/respond')) {
    const customer = await getAuthenticatedCustomer(req);
    if (!customer) return unauthorizedResponse();

    const parts = url.pathname.split('/');
    const surveyId = parts[parts.indexOf('survey') + 1];
    const body = await req.json();

    const { data: survey } = await supabase.from('surveys').select('*').eq('id', surveyId).eq('status', 'active').single();
    if (!survey) return errorResponse('Pesquisa não disponível', 404);

    const { data, error } = await supabase.from('survey_responses').insert({
      survey_id: surveyId,
      customer_id: customer.id,
      answers: body.answers || {},
      nps_score: body.nps_score,
      completed_at: new Date().toISOString(),
    }).select().single();

    if (error) {
      if (error.code === '23505') return errorResponse('Você já respondeu esta pesquisa');
      return errorResponse(error.message);
    }

    if (survey.bonus_points > 0) {
      await supabase.from('point_transactions').insert({
        customer_id: customer.id,
        type: 'bonus',
        points: survey.bonus_points,
        description: `Bônus: pesquisa "${survey.title}"`,
      });
    }

    return jsonResponse(data, 201);
  }

  // ─── POST /public-api/referral ─── Usar código de indicação (autenticado)
  if (method === 'POST' && url.pathname.includes('/referral')) {
    const customer = await getAuthenticatedCustomer(req);
    if (!customer) return unauthorizedResponse();

    const body = await req.json();
    if (!body.referral_code) return errorResponse('referral_code obrigatório');

    const { data: referrer } = await supabase
      .from('customers')
      .select('id')
      .eq('referral_code', body.referral_code.toUpperCase())
      .single();

    if (!referrer) return errorResponse('Código de indicação inválido', 404);
    if (referrer.id === customer.id) return errorResponse('Não é possível indicar a si mesmo');

    const { data: bonusReferrer } = await supabase.from('system_settings').select('value').eq('key', 'referral_bonus_referrer').single();
    const { data: bonusReferred } = await supabase.from('system_settings').select('value').eq('key', 'referral_bonus_referred').single();

    const pointsReferrer = bonusReferrer?.value || 200;
    const pointsReferred = bonusReferred?.value || 100;

    const { error } = await supabase.from('referrals').insert({
      referrer_id: referrer.id,
      referred_id: customer.id,
      bonus_points_referrer: pointsReferrer,
      bonus_points_referred: pointsReferred,
      is_confirmed: true,
      confirmed_at: new Date().toISOString(),
    });

    if (error) {
      if (error.code === '23505') return errorResponse('Indicação já registrada');
      return errorResponse(error.message);
    }

    await Promise.all([
      supabase.from('point_transactions').insert({
        customer_id: referrer.id, type: 'referral', points: pointsReferrer,
        description: 'Bônus por indicação',
      }),
      supabase.from('point_transactions').insert({
        customer_id: customer.id, type: 'referral', points: pointsReferred,
        description: 'Bônus: indicado por amigo',
      }),
    ]);

    return jsonResponse({ success: true, bonus_received: pointsReferred });
  }

  return errorResponse('Rota não encontrada', 404);
});
