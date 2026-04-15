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
// Edge Function: /dashboard
// Estatísticas e analytics do painel admin





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const supabase = getSupabaseClient(req);

  // ─── GET /dashboard/stats ─── Números principais
  if (url.pathname.includes('/stats')) {
    const { data, error } = await supabase.from('v_dashboard_stats').select('*').single();
    if (error) return errorResponse(error.message);

    // Calcular taxa de retenção (ativos 90d / total)
    const retention = data.total_customers > 0
      ? Math.round((data.active_customers_90d / data.total_customers) * 100)
      : 0;

    return jsonResponse({
      total_customers: data.total_customers,
      new_customers_30d: data.new_customers_30d,
      active_customers_90d: data.active_customers_90d,
      retention_rate: retention,
      points_issued_30d: data.points_issued_30d,
      points_redeemed_30d: data.points_redeemed_30d,
      redemptions_30d: data.redemptions_30d,
      pending_redemptions: data.pending_redemptions,
      revenue_influenced_30d: data.revenue_influenced_30d,
    });
  }

  // ─── GET /dashboard/tiers ─── Distribuição por tier
  if (url.pathname.includes('/tiers')) {
    const { data, error } = await supabase.from('v_tier_distribution').select('*');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── GET /dashboard/monthly ─── Pontos por mês (12 meses)
  if (url.pathname.includes('/monthly')) {
    const { data, error } = await supabase.from('v_monthly_points').select('*');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── GET /dashboard/top-prizes ─── Prêmios mais resgatados
  if (url.pathname.includes('/top-prizes')) {
    const { data, error } = await supabase
      .from('v_top_prizes')
      .select('*')
      .limit(10);
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ─── GET /dashboard/recent ─── Atividades recentes
  if (url.pathname.includes('/recent')) {
    const [transactions, redemptions, imports] = await Promise.all([
      supabase.from('point_transactions')
        .select('id, type, points, description, created_at, customers(full_name)')
        .order('created_at', { ascending: false }).limit(10),
      supabase.from('redemptions')
        .select('id, status, points_spent, created_at, customers(full_name), prizes(name)')
        .order('created_at', { ascending: false }).limit(10),
      supabase.from('import_logs')
        .select('id, file_name, status, success_rows, error_rows, created_at')
        .order('created_at', { ascending: false }).limit(5),
    ]);

    return jsonResponse({
      recent_transactions: transactions.data || [],
      recent_redemptions: redemptions.data || [],
      recent_imports: imports.data || [],
    });
  }

  // ─── GET /dashboard (geral) ─── Tudo junto
  const [stats, tiers, monthly, topPrizes] = await Promise.all([
    supabase.from('v_dashboard_stats').select('*').single(),
    supabase.from('v_tier_distribution').select('*'),
    supabase.from('v_monthly_points').select('*'),
    supabase.from('v_top_prizes').select('*').limit(10),
  ]);

  return jsonResponse({
    stats: stats.data,
    tier_distribution: tiers.data,
    monthly_points: monthly.data,
    top_prizes: topPrizes.data,
  });
});
