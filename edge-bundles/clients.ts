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
// Edge Function: /clients
// CRUD completo de clientes + busca + filtros





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseClient(req);
  const admin = getSupabaseAdmin();
  const userId = await getUserId(req);

  // ─── GET /clients ─── Lista com filtros e paginação
  if (method === 'GET' && !url.pathname.includes('/clients/')) {
    const { limit, offset } = parsePagination(url);
    const search = parseSearch(url);
    const tier = url.searchParams.get('tier');
    const active = url.searchParams.get('active');
    const sort = url.searchParams.get('sort') || 'created_at';
    const order = url.searchParams.get('order') || 'desc';

    let query = supabase
      .from('customers')
      .select('*, customer_categories(name, color)', { count: 'exact' });

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,cpf.ilike.%${search}%,phone.ilike.%${search}%`);
    }
    if (tier) query = query.eq('tier', tier);
    if (active !== null && active !== undefined) query = query.eq('is_active', active === 'true');

    query = query.order(sort, { ascending: order === 'asc' }).range(offset, offset + limit - 1);

    const { data, count, error } = await query;
    if (error) return errorResponse(error.message);
    return jsonResponse({ data, total: count, page: Math.floor(offset / limit) + 1, limit });
  }

  // ─── GET /clients/:id ─── Detalhe do cliente com histórico
  if (method === 'GET') {
    const id = url.pathname.split('/').pop();

    const { data: customer, error } = await supabase
      .from('customers')
      .select('*, customer_categories(name, color, benefits)')
      .eq('id', id)
      .single();

    if (error) return errorResponse('Cliente não encontrado', 404);

    // Buscar transações recentes
    const { data: transactions } = await supabase
      .from('point_transactions')
      .select('*, point_rules(name)')
      .eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(50);

    // Buscar resgates
    const { data: redemptions } = await supabase
      .from('redemptions')
      .select('*, prizes(name, image_url)')
      .eq('customer_id', id)
      .order('created_at', { ascending: false })
      .limit(20);

    // Buscar indicações feitas
    const { data: referrals } = await supabase
      .from('referrals')
      .select('*, referred:referred_id(full_name, email)')
      .eq('referrer_id', id);

    return jsonResponse({ ...customer, transactions, redemptions, referrals });
  }

  // ─── POST /clients ─── Criar cliente
  if (method === 'POST') {
    const body = await req.json();

    const { data, error } = await supabase
      .from('customers')
      .insert({
        full_name: body.full_name,
        email: body.email || null,
        phone: body.phone || null,
        cpf: body.cpf || null,
        birth_date: body.birth_date || null,
        city: body.city || null,
        state: body.state || null,
        zip_code: body.zip_code || null,
        address: body.address || null,
        notes: body.notes || null,
        tags: body.tags || [],
        external_id: body.external_id || null,
      })
      .select()
      .single();

    if (error) return errorResponse(error.message);

    // Bônus de boas-vindas
    const { data: settings } = await admin.from('system_settings').select('value').eq('key', 'welcome_bonus').single();
    const welcomeBonus = settings?.value || 100;

    if (welcomeBonus > 0) {
      await admin.from('point_transactions').insert({
        customer_id: data.id,
        type: 'bonus',
        points: welcomeBonus,
        description: 'Bônus de boas-vindas',
        created_by: userId,
      });
    }

    await logAudit(admin, userId, 'create', 'customer', data.id, null, data);
    return jsonResponse(data, 201);
  }

  // ─── PUT /clients/:id ─── Atualizar cliente
  if (method === 'PUT' || method === 'PATCH') {
    const id = url.pathname.split('/').pop();
    const body = await req.json();

    // Pegar dados antigos para auditoria
    const { data: oldData } = await supabase.from('customers').select('*').eq('id', id).single();

    const { data, error } = await supabase
      .from('customers')
      .update({
        full_name: body.full_name,
        email: body.email,
        phone: body.phone,
        cpf: body.cpf,
        birth_date: body.birth_date,
        city: body.city,
        state: body.state,
        zip_code: body.zip_code,
        address: body.address,
        notes: body.notes,
        tags: body.tags,
        is_active: body.is_active,
        external_id: body.external_id,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'update', 'customer', id!, oldData, data);
    return jsonResponse(data);
  }

  // ─── DELETE /clients/:id ─── Desativar cliente (soft delete)
  if (method === 'DELETE') {
    if (!await requireAdmin(req)) return forbiddenResponse();

    const id = url.pathname.split('/').pop();
    const { error } = await supabase
      .from('customers')
      .update({ is_active: false })
      .eq('id', id);

    if (error) return errorResponse(error.message);
    await logAudit(admin, userId, 'delete', 'customer', id!, null, null);
    return jsonResponse({ success: true });
  }

  return errorResponse('Método não suportado', 405);
});
