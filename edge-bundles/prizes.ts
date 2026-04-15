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
// Edge Function: /prizes
// CRUD de prêmios e categorias





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseClient(req);
  const admin = getSupabaseAdmin();
  const userId = await getUserId(req);

  // ─── CATEGORIAS ───

  // GET /prizes/categories
  if (method === 'GET' && url.pathname.includes('/categories')) {
    const { data, error } = await supabase
      .from('prize_categories')
      .select('*, prizes(count)')
      .order('sort_order');

    if (error) return errorResponse(error.message);
    return jsonResponse(data);
  }

  // POST /prizes/categories
  if (method === 'POST' && url.pathname.includes('/categories')) {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const body = await req.json();
    const { data, error } = await supabase
      .from('prize_categories')
      .insert({
        name: body.name,
        slug: body.slug || body.name.toLowerCase().replace(/\s+/g, '-'),
        description: body.description,
        icon: body.icon,
        sort_order: body.sort_order || 0,
      })
      .select()
      .single();
    if (error) return errorResponse(error.message);
    return jsonResponse(data, 201);
  }

  // ─── PRÊMIOS ───

  // GET /prizes
  if (method === 'GET' && !url.pathname.includes('/categories')) {
    const { limit, offset } = parsePagination(url);
    const categoryId = url.searchParams.get('category_id');
    const type = url.searchParams.get('type');
    const active = url.searchParams.get('active');
    const featured = url.searchParams.get('featured');
    const minTier = url.searchParams.get('min_tier');

    let query = supabase
      .from('prizes')
      .select('*, prize_categories(name, slug, icon)', { count: 'exact' });

    if (categoryId) query = query.eq('category_id', categoryId);
    if (type) query = query.eq('type', type);
    if (active !== null) query = query.eq('is_active', active !== 'false');
    if (featured === 'true') query = query.eq('is_featured', true);
    if (minTier) query = query.eq('min_tier', minTier);

    query = query.order('points_required').range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) return errorResponse(error.message);
    return jsonResponse({ data, total: count });
  }

  // POST /prizes
  if (method === 'POST') {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const body = await req.json();

    const { data, error } = await supabase
      .from('prizes')
      .insert({
        category_id: body.category_id,
        name: body.name,
        description: body.description,
        type: body.type || 'brinde',
        points_required: body.points_required,
        monetary_value: body.monetary_value,
        image_url: body.image_url,
        stock: body.stock,
        max_per_customer: body.max_per_customer,
        min_tier: body.min_tier || 'basic',
        is_active: body.is_active ?? true,
        is_featured: body.is_featured ?? false,
        valid_from: body.valid_from,
        valid_until: body.valid_until,
        terms: body.terms,
      })
      .select()
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'create', 'prize', data.id, null, data);
    return jsonResponse(data, 201);
  }

  // PUT /prizes/:id
  if (method === 'PUT' || method === 'PATCH') {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').pop();
    const body = await req.json();

    const { data: oldData } = await supabase.from('prizes').select('*').eq('id', id).single();

    const { data, error } = await supabase
      .from('prizes')
      .update(body)
      .eq('id', id)
      .select()
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'update', 'prize', id!, oldData, data);
    return jsonResponse(data);
  }

  // DELETE /prizes/:id
  if (method === 'DELETE') {
    if (!await requireAdmin(req)) return forbiddenResponse();
    const id = url.pathname.split('/').pop();

    const { error } = await supabase
      .from('prizes')
      .update({ is_active: false })
      .eq('id', id);

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'delete', 'prize', id!, null, null);
    return jsonResponse({ success: true });
  }

  return errorResponse('Rota não encontrada', 404);
});
