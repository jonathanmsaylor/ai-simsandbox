declare const process: { env: Record<string, string | undefined> };
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_ORIGINS = new Set([
  'https://jonathanmsaylor.github.io',
]);

const MODEL = 'gpt-5.6-luna';
const REL_KEYS = ['trust', 'affection', 'respect', 'attraction', 'fear', 'resentment'];
const NEED_KEYS = ['energy','hunger','stress','hydration','health','pain','hygiene','bladder','socialConnection','mood','focus','fitness','intimacyNeed','security','sleepDebtHours'];
const WORLD_OPS = new Set([
  'create_entity','create_npc','learn_phone_number','update_entity','move_entity','consume_entity','remove_entity','transfer_entity',
  'set_environment','set_npc_presence','create_commitment','record_interaction','urgent_condition','clear_urgent_condition','schedule_event',
  'create_location','discover_location','move_player','create_order','purchase_item','create_appointment','reschedule_appointment','cancel_appointment','physical_interaction',
]);

function cors(origin: string) {
  const h: Record<string,string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type, X-AI-Sandbox-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (ALLOWED_ORIGINS.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(body: unknown, status = 200, origin = '') {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) });
}

function clamp(n: unknown, lo: number, hi: number, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

function str(v: unknown, max = 300) {
  return String(v ?? '').slice(0, max);
}

function plainObject(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
}

function extractOutputText(raw: any) {
  if (typeof raw?.output_text === 'string') return raw.output_text.trim();
  const chunks: string[] = [];
  if (Array.isArray(raw?.output)) {
    for (const item of raw.output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part && part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
      }
    }
  }
  return chunks.join('').trim();
}

function parseJsonText(text: string) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(t); } catch {}
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)); } catch {}
  }
  return null;
}

function usage(raw: any) {
  const u = raw?.usage || {};
  return {
    input_tokens: Number(u.input_tokens || 0),
    cached_input_tokens: Number(u.input_tokens_details?.cached_tokens || 0),
    output_tokens: Number(u.output_tokens || 0),
    total_tokens: Number(u.total_tokens || (Number(u.input_tokens || 0) + Number(u.output_tokens || 0))),
  };
}

async function callOpenAI(input: string, maxOutputTokens: number) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      input,
      reasoning: { effort: 'none' },
      max_output_tokens: maxOutputTokens,
      store: false,
    }),
  });
  let raw: any = null;
  try { raw = await response.json(); } catch {}
  if (!response.ok) {
    const err = new Error('OpenAI request failed');
    (err as any).status = response.status;
    (err as any).detail = str(raw?.error?.message || `HTTP ${response.status}`, 300);
    throw err;
  }
  return { raw, text: extractOutputText(raw) };
}

function normalizeSocial(v: unknown) {
  const s = plainObject(v);
  const effects = plainObject(s.relationship_effects ?? s.relationshipEffects);
  const relationship_effects: Record<string,number> = {};
  for (const key of REL_KEYS) relationship_effects[key] = clamp(effects[key], -6, 6, 0);
  const mem = plainObject(s.memory);
  const meaningful = Boolean(s.meaningful);
  return {
    meaningful,
    intent: meaningful ? str(s.intent || 'meaningful interaction', 50) : 'neutral',
    perceived_as_flirting: meaningful ? Boolean(s.perceived_as_flirting ?? s.perceivedAsFlirting) : false,
    flirt_reception: meaningful ? (['positive','neutral','negative','none'].includes(String(s.flirt_reception ?? s.flirtReception)) ? String(s.flirt_reception ?? s.flirtReception) : 'none') : 'none',
    relationship_effects: meaningful ? relationship_effects : Object.fromEntries(REL_KEYS.map(k => [k,0])),
    visible_feedback: meaningful ? str(s.visible_feedback ?? s.visibleFeedback, 180) : '',
    memory: meaningful && mem.create && mem.event ? {
      create: true,
      event: str(mem.event, 260),
      emotional_valence: clamp(mem.emotional_valence ?? mem.emotionalValence, -1, 1, 0),
      emotional_strength: clamp(mem.emotional_strength ?? mem.emotionalStrength, 0, 1, .25),
      importance: clamp(mem.importance, 0, 1, .35),
    } : { create:false, event:'', emotional_valence:0, emotional_strength:0, importance:0 },
  };
}

function safeWorldEffect(fx: unknown) {
  const x = plainObject(fx);
  const op = str(x.op, 40);
  if (!WORLD_OPS.has(op)) return null;
  const out: Record<string,any> = { op };
  const allowed = [
    'entity','npc','person','value','entity_id','entityId','location_id','locationId','container_id','containerId','amount','owner','new_owner','newOwner',
    'changes','npc_id','npcId','method','activity','duration_minutes','reason','basis','commitment','kind','quality','minutes','id','condition_id','condition','event',
    'location','query','name','services','destination','mode','order','purchase','productName','item_name','seller','price','destinationLocationId','destination_location_id','delivery_minutes','appointment','appointment_id','start_at','startAt','when','title','interaction','npc_initiated',
  ];
  for (const k of allowed) if (x[k] !== undefined) out[k] = x[k];
  // Bound nested arbitrary payloads so a model cannot balloon browser state.
  const encoded = JSON.stringify(out);
  if (encoded.length > 5000) return null;
  return out;
}

function normalizeNpcReply(v: unknown, req: any) {
  const x = plainObject(v);
  const reply = str(x.reply, 1200).trim();
  if (!reply) throw new Error('Model returned no NPC reply');
  const effects = Array.isArray(x.world_effects) ? x.world_effects.map(safeWorldEffect).filter(Boolean).slice(0,12) : [];
  return {
    type: 'npc_reply',
    reply,
    tone: str(x.tone || 'natural', 50),
    social: normalizeSocial(x.social),
    world_effects: effects,
  };
}

function normalizeAction(v: unknown) {
  const x = plainObject(v);
  const eff = plainObject(x.effects);
  const conditionIn = plainObject(eff.condition);
  const condition: Record<string,number> = {};
  for (const key of NEED_KEYS) if (conditionIn[key] !== undefined) condition[key] = clamp(conditionIn[key], -30, 30, 0);

  const statuses = Array.isArray(eff.statuses) ? eff.statuses.slice(0,6).map((s: any) => ({
    id: str(s?.id || s?.label, 48), label: str(s?.label,80), intensity: str(s?.intensity || 'mild',24),
    duration_minutes: clamp(s?.duration_minutes, 5, 1440, 60),
    impairs_driving: Boolean(s?.impairs_driving ?? s?.impairsDriving),
    modifiers: {
      coordination: clamp(s?.modifiers?.coordination,-25,25,0), composure: clamp(s?.modifiers?.composure,-25,25,0), driving: clamp(s?.modifiers?.driving,-25,25,0),
    },
  })).filter((s:any)=>s.label) : [];

  const relationships = Array.isArray(eff.relationships) ? eff.relationships.slice(0,8).map((r:any) => {
    const o: Record<string,any> = { npc_id:str(r?.npc_id,60), reason:str(r?.reason,240) };
    for (const k of REL_KEYS) o[k] = clamp(r?.[k],-8,8,0);
    return o;
  }).filter((r:any)=>r.npc_id) : [];

  const skills = Array.isArray(eff.skills) ? eff.skills.slice(0,8).map((q:any)=>({skill:str(q?.skill,50),delta:clamp(q?.delta,0,1,0)})).filter((q:any)=>q.skill&&q.delta) : [];
  const consumables = Array.isArray(eff.consumables) ? eff.consumables.slice(0,6).map((c:any)=>({item_id:str(c?.item_id,60),delta_grams:clamp(c?.delta_grams,-28,28,0)})) : [];
  const situation_updates = Array.isArray(eff.situation_updates) ? eff.situation_updates.slice(0,8).map((u:any)=>({id:str(u?.id,80),status:str(u?.status,30),add_known_information:Array.isArray(u?.add_known_information)?u.add_known_information.slice(0,4).map((a:any)=>str(a,220)):[]})).filter((u:any)=>u.id) : [];
  const moneyRaw = plainObject(eff.money);
  const money = moneyRaw.description && moneyRaw.delta !== undefined ? { delta: clamp(moneyRaw.delta,-1000,1000,0), description:str(moneyRaw.description,100) } : undefined;
  const injuryRaw = plainObject(eff.injury);
  const injury = injuryRaw.occurred ? { occurred:true, description:str(injuryRaw.description || 'Minor injury',180) } : undefined;

  const worldEffectsRaw = [
    ...(Array.isArray(x.world_effects) ? x.world_effects : []),
    ...(Array.isArray(eff.world_effects) ? eff.world_effects : []),
  ];
  const world_effects = worldEffectsRaw.map(safeWorldEffect).filter(Boolean).slice(0,24);

  const memories = Array.isArray(x.memories) ? x.memories.slice(0,8).map((m:any)=>({
    npc_id:str(m?.npc_id,60), event:str(m?.event,260), emotional_valence:clamp(m?.emotional_valence,-1,1,0), emotional_strength:clamp(m?.emotional_strength,0,1,.25), importance:clamp(m?.importance,0,1,.3), private:Boolean(m?.private),
  })).filter((m:any)=>m.npc_id&&m.event) : [];

  const possible = x.possible !== false;
  return {
    type: 'action_resolution',
    possible,
    narrative: str(x.narrative || (possible ? 'The action is resolved.' : 'The attempted action cannot occur as stated.'), 1800),
    duration_minutes: clamp(x.duration_minutes, 1, 1440, 4),
    social_intent: str(x.social_intent || '',50),
    perceived_as_flirting: Boolean(x.perceived_as_flirting ?? x.perceivedAsFlirting),
    flirt_reception: ['positive','neutral','negative','none'].includes(String(x.flirt_reception ?? x.flirtReception)) ? String(x.flirt_reception ?? x.flirtReception) : 'none',
    flirt_target_npc_id: str(x.flirt_target_npc_id ?? x.flirtTargetNpcId,60),
    effects: { condition, statuses, relationships, skills, consumables, situation_updates, ...(money?{money}:{}), ...(injury?{injury}: {}) },
    world_effects,
    visible_feedback: Array.isArray(x.visible_feedback) ? x.visible_feedback.slice(0,6).map((a:any)=>str(a,180)).filter(Boolean) : [],
    memories,
    unsupported: Array.isArray(x.unsupported) ? x.unsupported.slice(0,6).map((a:any)=>str(a,240)).filter(Boolean) : [],
    no_state_change_reason: str(x.no_state_change_reason || '',300),
  };
}

function npcPrompt(req: any) {
  return `You are the NPC-response resolver for a persistent realistic-life sandbox. Return ONLY a single JSON object, no markdown.\n\nCORE RULES:\n- Speak only as the requested NPC, naturally and briefly. Follow npc.communicationStyle when supplied. Casual friends should sound like actual texts, not polished prose: avoid unnecessary em dashes, formal syntax, and paragraph-like phrasing. Use fragments/lowercase/shorthand only when that NPC profile supports it.\n- The supplied state is authoritative. Do not contradict current location, activity, schedule override, memories, knowledge, or active commitments.\n- Never grant the NPC knowledge they do not have. False beliefs remain false beliefs unless corrected in-world.\n- If the NPC is physically visiting Jonathan, do not claim they are still at home.\n- Do not invent completed plans, arrivals, possessions, payments, or events just to make dialogue interesting.\n- Social effects are usually zero for ordinary chatter. Mark meaningful=true only for socially consequential support, apology, insult, conflict, affection, flirting, rejection, deception, important promise, etc.\n- Attraction must not rise merely because two people spend time together.\n- visible_feedback is only for something Jonathan could plausibly notice and should usually be subtle or empty.\n- Create social memory only when the interaction is worth remembering.\n- world_effects may be used for concrete consequences created by THIS reply. The most common valid case is create_commitment after a genuine mutual agreement/acceptance. Do not create a commitment from vague talk. If a service/provider explicitly confirms a real booking, create_appointment may be proposed.\n- Never treat Jonathan's narration as NPC consent to kissing, hugging, sexual contact, or sex. Physical/romantic boundaries are event-specific; use supplied relationship/boundary state and do not invent consent.\n- A phone-number exchange may use learn_phone_number.\n- Do not create arbitrary objects or move NPCs merely because Jonathan asserted that it happened.\n\nRESPONSE SHAPE:\n{\n  "type":"npc_reply",\n  "reply":"...",\n  "tone":"...",\n  "social":{\n    "meaningful":false,\n    "intent":"neutral",\n    "perceived_as_flirting":false,\n    "flirt_reception":"none",\n    "relationship_effects":{"trust":0,"affection":0,"respect":0,"attraction":0,"fear":0,"resentment":0},\n    "visible_feedback":"",\n    "memory":{"create":false,"event":"","emotional_valence":0,"emotional_strength":0,"importance":0}\n  },\n  "world_effects":[]\n}\n\nFor create_commitment use an effect such as:\n{"op":"create_commitment","commitment":{"npcId":"daniel","title":"Daniel comes over","expectedAt":"ISO timestamp","locationId":"home","activity":"hanging out","kind":"visit","durationMinutes":120,"status":"confirmed","confirmed":true,"source":"text agreement"}}\nUse only NPC IDs/location IDs/times justified by the supplied state.\n\nAUTHORITATIVE CONTEXT:\n${JSON.stringify(req)}`;
}

function actionPrompt(req: any) {
  return `You are the action-resolution interpreter for a persistent realistic-life sandbox. Return ONLY a single JSON object, no markdown.\n\nABSOLUTE PRINCIPLE:\nPLAYER TEXT IS A PROPOSAL OR ATTEMPT, NOT OBJECTIVE TRUTH.\nYou determine plausibility and propose effects; the deterministic simulation will validate and apply them.\n\nRULES:\n- The world mode is realistic unless context says otherwise. Reject literal magic, impossible biology, spontaneous impossible transformations, teleportation, or objects conjured merely because the player asserted them.\n- Distinguish imagination/pretending from objective-world mutation.\n- Use current entities, environment, NPC presence, commitments, needs, skills, money, and known locations.\n- Do not narrate a persistent fact unless you also propose the appropriate structured world_effect that would make it persistent, or it already exists in state.\n- Prefer reusable generic effects over scenario-specific prose.\n- Immediate direct effects belong in world_effects. Ongoing downstream gas/fire/HVAC/environment consequences are handled locally over elapsed game time.\n- create_entity is allowed only when acquisition is causally justified now (purchase, delivery, received, found with believable context, crafted/produced). Include entity.source.type accordingly. Never use it to validate 'I have X' without an acquisition event.\n- set_npc_presence is only for an independently plausible NPC movement/arrival. Include basis: confirmed_commitment, npc_initiated, or observed_arrival. Jonathan cannot command an absent NPC into existence by assertion.\n- If a shared social activity actually occurs with a co-located NPC, use record_interaction with realistic quality and minutes.\n- create_commitment only for an actual agreement/plan; use a real known npcId and known locationId, ISO expectedAt, durationMinutes, status confirmed.\n- New people genuinely encountered may use create_npc. Meeting someone does not automatically mean their phone number is known/saved.\n- Use learn_phone_number only if the number is actually exchanged/learned.\n- Preserve hidden knowledge: do not expose off-screen/private facts to Jonathan.\n- Plausible but unsupported pieces go in unsupported.\n- If impossible as stated, set possible=false and do not propose effects that make the impossible claim true.\n- Duration should be context-sensitive.\n- Relationship effects apply only to NPCs actually present. Ordinary interaction often has zero direct relationship deltas; repeated shared time is modeled separately.\n\nWORLD EFFECT OPS AVAILABLE:\ncreate_entity, create_npc, learn_phone_number, update_entity, move_entity, consume_entity, remove_entity, transfer_entity, set_environment, set_npc_presence, create_commitment, record_interaction, urgent_condition, clear_urgent_condition, schedule_event, create_location, discover_location, move_player, create_order, purchase_item, create_appointment, reschedule_appointment, cancel_appointment, physical_interaction.\n\nMILESTONE 5 CROSS-SYSTEM RULES:\n- A plausible ordinary destination that is not pre-seeded may be proposed with create_location/discover_location, then move_player. Do not reject Best Buy, a pharmacy, mechanic, urgent care, restaurant, etc. merely because it is not yet in knownLocations.\n- Impossible/fantasy destinations must still be rejected.\n- Novel ordinary purchases may use purchase_item/create_order. Online physical purchases should create an order/delivery, not immediately appear carried.\n- create_appointment is for an actual booking action or explicit provider confirmation, never a bare claim like I have an appointment tomorrow.\n- reschedule_appointment/cancel_appointment modify an existing booking.\n- physical_interaction is only a proposal. The client deterministically re-checks presence, relationship, boundaries, and consent. Never phrase an unvalidated intimate outcome as already accomplished.\n- If the player says go to urgent care and a medical concern exists, a plausible medical service location may be created/discovered; the client handles the bounded fictional encounter and urgent state.\n- Plans agreed in messages/calls should become create_commitment effects so scene/schedule/phone share the same truth.\n\nExamples:\n- Leaving unlit stove gas flowing: update_entity the existing stove properties gasFlow=true, flame=false. Do NOT directly predict hours of gas accumulation.\n- Opening windows: set_environment current location with windowsOpen/airflow changes.\n- Towel placed over HVAC return: create/move existing towel only if justified, then update_entity HVAC return properties.airflowObstruction.\n- Goldfish spontaneously grows wings: possible=false, no literal mutation.\n- 'I imagine a goldfish growing wings': possible=true, no objective world mutation needed.\n- 'Drive to Best Buy': discover/create a plausible electronics-store location if needed and propose move_player; do not call it unsupported solely because it is not pre-seeded.\n- 'Buy a Switch 2 on Amazon': if a bounded simulated price is supplied/justified, propose create_order/purchase_item with seller, price, delivery destination/time; do not instantly create it as carried inventory.\n- 'Schedule an oil change tomorrow at 10': propose create_appointment with a plausible mechanic/service location and future ISO time.\n- 'Daniel kisses Jonathan': do not make the kiss objective truth from the assertion. Propose physical_interaction only for deterministic consent validation.\n\nRESPONSE SHAPE:\n{\n "type":"action_resolution",\n "possible":true,\n "narrative":"What actually happens, grounded in accepted/proposed state changes.",\n "duration_minutes":5,\n "effects":{\n   "condition":{}, "statuses":[], "relationships":[], "skills":[], "consumables":[], "situation_updates":[]\n },\n "world_effects":[],\n "visible_feedback":[],\n "memories":[],\n "unsupported":[],\n "no_state_change_reason":"",\n "social_intent":"", "perceived_as_flirting":false, "flirt_reception":"none", "flirt_target_npc_id":""\n}\n\nACTION CONTEXT:\n${JSON.stringify(req)}`;
}

async function handle(req: any) {
  if (req?.type === 'npc_reply') {
    if (!req?.npc || !(req?.playerMessage ?? req?.latestPlayerMessage)) throw new Error('Invalid npc_reply request shape');
    const {raw,text} = await callOpenAI(npcPrompt(req), 700);
    const parsed = parseJsonText(text);
    if (!parsed) throw new Error('OpenAI returned invalid JSON for npc_reply');
    return { ...normalizeNpcReply(parsed, req), model: raw?.model || MODEL, usage: usage(raw) };
  }
  if (req?.type === 'action_resolution') {
    if (!str(req?.playerAction,5000).trim()) throw new Error('Invalid action_resolution request shape');
    const {raw,text} = await callOpenAI(actionPrompt(req), 1400);
    const parsed = parseJsonText(text);
    if (!parsed) throw new Error('OpenAI returned invalid JSON for action_resolution');
    return { ...normalizeAction(parsed), model: raw?.model || MODEL, usage: usage(raw) };
  }
  throw new Error('Unsupported request type');
}

export async function OPTIONS(request: Request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403, headers: cors(origin) });
  return new Response(null, { status: 204, headers: cors(origin) });
}

export async function POST(request: Request) {
  const origin = request.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.has(origin)) return json({ error:'Origin not allowed' }, 403, origin);

  const expectedToken = process.env.AI_SANDBOX_ACCESS_TOKEN || '';
  if (!expectedToken) return json({ error:'Server access token is not configured' }, 500, origin);
  const suppliedToken = request.headers.get('X-AI-Sandbox-Token') || '';
  if (suppliedToken !== expectedToken) return json({ error:'Unauthorized' }, 401, origin);
  if (!process.env.OPENAI_API_KEY) return json({ error:'OPENAI_API_KEY is not configured' }, 500, origin);

  let body: any;
  try { body = await request.json(); }
  catch { return json({ error:'Invalid JSON' }, 400, origin); }

  try {
    const result = await handle(body);
    return json(result, 200, origin);
  } catch (err: any) {
    const message = String(err?.message || 'Request failed');
    if (/Invalid .*request shape|Unsupported request type/.test(message)) return json({ error:message }, 400, origin);
    // Do not echo prompts, request bodies, NPC state, model output, secrets, or other private content.
    return json({ error:'AI resolution failed', details: message.slice(0,180) }, 502, origin);
  }
}
