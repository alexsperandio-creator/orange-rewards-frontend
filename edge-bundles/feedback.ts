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
// Edge Function: /feedback
// Pesquisas de satisfação e respostas NPS





serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!await requireStaff(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const method = req.method;
  const supabase = getSupabaseClient(req);
  const admin = getSupabaseAdmin();

  // ─── GET /feedback/surveys ─── Pesquisas com stats
  if (method === 'GET' && url.pathname.includes('/surveys')) {
    const surveyId = url.pathname.split('/').pop();
    const isDetail = surveyId && surveyId !== 'surveys';

    if (isDetail) {
      const { data: survey } = await supabase.from('surveys').select('*').eq('id', surveyId).single();
      if (!survey) return errorResponse('Pesquisa não encontrada', 404);

      // Buscar respostas
      const { data: responses } = await supabase
        .from('survey_responses')
        .select('*, customers(full_name, email, tier)')
        .eq('survey_id', surveyId)
        .order('created_at', { ascending: false });

      // Calcular NPS
      const npsScores = (responses || []).filter(r => r.nps_score !== null).map(r => r.nps_score!);
      let nps = null;
      if (npsScores.length > 0) {
        const promoters = npsScores.filter(s => s >= 9).length;
        const detractors = npsScores.filter(s => s <= 6).length;
        nps = Math.round(((promoters - detractors) / npsScores.length) * 100);
      }

      return jsonResponse({
        ...survey,
        responses: responses || [],
        stats: {
          total_responses: (responses || []).length,
          nps_score: nps,
          promoters: npsScores.filter(s => s >= 9).length,
          neutrals: npsScores.filter(s => s >= 7 && s <= 8).length,
          detractors: npsScores.filter(s => s <= 6).length,
          avg_score: npsScores.length > 0
            ? Math.round(npsScores.reduce((a, b) => a + b, 0) / npsScores.length * 10) / 10
            : null,
        },
      });
    }

    // Listar todas com contagem de respostas
    const { data: surveys } = await supabase.from('surveys').select('*').order('created_at', { ascending: false });

    const enriched = await Promise.all((surveys || []).map(async (s) => {
      const { count } = await supabase
        .from('survey_responses')
        .select('id', { count: 'exact' })
        .eq('survey_id', s.id);
      return { ...s, response_count: count || 0 };
    }));

    return jsonResponse(enriched);
  }

  // ─── GET /feedback/nps ─── NPS geral do programa
  if (method === 'GET' && url.pathname.includes('/nps')) {
    const { data: responses } = await supabase
      .from('survey_responses')
      .select('nps_score, created_at')
      .not('nps_score', 'is', null)
      .order('created_at', { ascending: false });

    const scores = (responses || []).map(r => r.nps_score!);
    const promoters = scores.filter(s => s >= 9).length;
    const neutrals = scores.filter(s => s >= 7 && s <= 8).length;
    const detractors = scores.filter(s => s <= 6).length;
    const nps = scores.length > 0 ? Math.round(((promoters - detractors) / scores.length) * 100) : 0;

    // NPS por mês (últimos 6 meses)
    const monthlyNps: any[] = [];
    for (let i = 5; i >= 0; i--) {
      const start = new Date();
      start.setMonth(start.getMonth() - i);
      start.setDate(1);
      const end = new Date(start);
      end.setMonth(end.getMonth() + 1);

      const monthScores = (responses || [])
        .filter(r => new Date(r.created_at) >= start && new Date(r.created_at) < end)
        .map(r => r.nps_score!);

      if (monthScores.length > 0) {
        const mp = monthScores.filter(s => s >= 9).length;
        const md = monthScores.filter(s => s <= 6).length;
        monthlyNps.push({
          month: start.toISOString().slice(0, 7),
          nps: Math.round(((mp - md) / monthScores.length) * 100),
          responses: monthScores.length,
        });
      }
    }

    return jsonResponse({
      overall_nps: nps,
      total_responses: scores.length,
      promoters, neutrals, detractors,
      monthly: monthlyNps,
    });
  }

  return errorResponse('Rota não encontrada', 404);
});
