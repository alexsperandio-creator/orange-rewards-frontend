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
// Edge Function: /config
// Configurações do sistema, regras de pontos e categorias





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseClient(req);
  const admin = getSupabaseAdmin();
  const userId = await getUserId(req);

  // ═══════════════ SETTINGS ═══════════════

  // GET /config/settings
  if (method === 'GET' && url.pathname.includes('/settings')) {
    const { data, error } = await supabase.from('system_settings').select('*').order('key');
    if (error) return errorResponse(error.message);

    // Converter para objeto key-value
    const settings: Record<string, any> = {};
    (data || []).forEach(s => { settings[s.key] = s.value; });
    return jsonResponse(settings);
  }

  // PUT /config/settings
  if ((method === 'PUT' || method === 'PATCH') && url.pathname.includes('/settings')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const body = await req.json();

    for (const [key, value] of Object.entries(body)) {
      await admin.from('system_settings').upsert({
        key,
        value: typeof value === 'string' ? JSON.stringify(value) : value,
        updated_by: userId,
        updated_at: new Date().toISOString(),
      });
    }

    await logAudit(admin, userId, 'update', 'system_settings', null, null, body);
    return jsonResponse({ success: true });
  }

  // ═══════════════ REGRAS DE PONTOS ═══════════════

  // GET /config/rules
  if (method === 'GET' && url.pathname.includes('/rules')) {
    const { data, error } = await supabase.from('point_rules').select('*').order('name');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // POST /config/rules
  if (method === 'POST' && url.pathname.includes('/rules')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const body = await req.json();
    const { data, error } = await supabase.from('point_rules').insert({
      name: body.name,
      code: body.code,
      description: body.description,
      multiplier: body.multiplier || 1,
      min_value: body.min_value,
      max_points_per_transaction: body.max_points_per_transaction,
      is_active: body.is_active ?? true,
      valid_from: body.valid_from,
      valid_until: body.valid_until,
    }).select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data, 201);
  }

  // PUT /config/rules/:id
  if ((method === 'PUT' || method === 'PATCH') && url.pathname.includes('/rules/')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').pop();
    const body = await req.json();
    const { data, error } = await supabase.from('point_rules').update(body).eq('id', id).select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // DELETE /config/rules/:id
  if (method === 'DELETE' && url.pathname.includes('/rules/')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').pop();
    const { error } = await supabase.from('point_rules').update({ is_active: false }).eq('id', id);
    if (error) return errorResponse(error.message);
    return jsonResponse({ success: true });
  }

  // ═══════════════ CATEGORIAS DE CLIENTES (TIERS) ═══════════════

  // GET /config/tiers
  if (method === 'GET' && url.pathname.includes('/tiers')) {
    const { data, error } = await supabase
      .from('customer_categories')
      .select('*')
      .order('min_points');
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // PUT /config/tiers/:id
  if ((method === 'PUT' || method === 'PATCH') && url.pathname.includes('/tiers/')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').pop();
    const body = await req.json();
    const { data, error } = await supabase
      .from('customer_categories')
      .update({
        name: body.name,
        min_points: body.min_points,
        max_points: body.max_points,
        multiplier: body.multiplier,
        color: body.color,
        benefits: body.benefits,
      })
      .eq('id', id)
      .select().single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ═══════════════ AUDIT LOG ═══════════════

  // GET /config/audit
  if (method === 'GET' && url.pathname.includes('/audit')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const entityType = url.searchParams.get('entity_type');

    let query = supabase
      .from('audit_log')
      .select('*, profiles(full_name)')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (entityType) query = query.eq('entity_type', entityType);

    const { data, error } = await query;
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // ═══════════════ WEBHOOKS ═══════════════

  // GET /config/webhooks
  if (method === 'GET' && url.pathname.includes('/webhooks')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const { data, error } = await supabase
      .from('webhook_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  return errorResponse('Rota não encontrada', 404);
});
