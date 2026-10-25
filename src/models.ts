import type { SessionInfo, ThinkingMetadata, ThinkingOption } from './types';

export interface ModelOption extends ThinkingMetadata {
  ref: string;
  label: string;
  available: boolean;
}

export type GatewayRequest = (method: string, params?: any, timeoutMs?: number) => Promise<any>;

export function modelRef(model?: string, provider?: string): string {
  const id = model?.trim() || '';
  return id && provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
}

// Gateway names are case-insensitive, except provider-owned Signal group IDs
// and Matrix room/event IDs. Keep those opaque bytes intact while folding names.
function normalizeSessionKeyCase(key: string): string {
  const spans: { start: number; end: number }[] = [];
  const matrix = /^(?:(?:agent:[^:]*:)+:*)?matrix:(?:channel|group):/i.exec(key);
  if (matrix) {
    const start = matrix[0].length;
    const thread = key.toLowerCase().lastIndexOf(':thread:');
    if (thread >= start) {
      spans.push({ start, end: thread }, { start: thread + ':thread:'.length, end: key.length });
    } else spans.push({ start, end: key.length });
  }
  for (const match of key.matchAll(/(^|:)signal:group:([^:]+)/gi)) {
    const end = match.index + match[0].length;
    spans.push({ start: end - match[2].length, end });
  }
  let normalized = '';
  let cursor = 0;
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue;
    normalized += key.slice(cursor, span.start).toLowerCase() + key.slice(span.start, span.end);
    cursor = span.end;
  }
  return normalized + key.slice(cursor).toLowerCase();
}

export function toGatewaySessionKey(agentId: string, sessionKey: string): string {
  const cleanAgent = agentId?.trim().toLowerCase() || 'main';
  const cleanKey = normalizeSessionKeyCase(sessionKey?.trim() || 'main');
  // The main agent uses qualified store/event keys too. Keep unscoped sentinels intact.
  return cleanKey.startsWith('agent:') || cleanKey === 'global' || cleanKey === 'unknown'
    ? cleanKey
    : `agent:${cleanAgent}:${cleanKey}`;
}

export function sessionAgentId(key: string, fallback = 'main'): string {
  return /^agent:([^:]+):/i.exec(key.trim())?.[1].toLowerCase() || fallback.trim().toLowerCase();
}

// Collapse short, qualified, and case aliases, preferring Gateway metadata and human labels.
export function normalizeSessions(rows: SessionInfo[], fallbackAgent: string): SessionInfo[] {
  const sessions = new Map<string, { row: SessionInfo; qualified: boolean }>();
  const meaningfulLabel = (row: SessionInfo) =>
    typeof row.label === 'string' &&
    row.label.trim() &&
    row.label !== row.key &&
    row.label !== toGatewaySessionKey(row.agentId, row.key) &&
    row.label !== toGatewaySessionKey(row.agentId, row.key).replace(/^agent:[^:]+:/, '');
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !row.key.trim()) continue;
    const agentId = sessionAgentId(row.key, row.agentId || fallbackAgent);
    const key = toGatewaySessionKey(agentId, row.key);
    const qualified = row.key === key;
    const previous = sessions.get(key);
    const preferred = previous?.qualified && !qualified ? previous.row : row;
    const other = preferred === row ? previous?.row : row;
    const merged = { ...other, ...preferred, key, agentId };
    if (!meaningfulLabel(preferred) && other && meaningfulLabel(other)) merged.label = other.label;
    if (merged.label === key) merged.label = key.replace(/^agent:[^:]+:/, '');
    sessions.set(key, { row: merged, qualified: qualified || !!previous?.qualified });
  }
  return [...sessions.values()].map((entry) => entry.row);
}

export function normalizeModels(result: any): ModelOption[] {
  if (!Array.isArray(result?.models))
    throw new Error('The Gateway returned an invalid model list.');
  const choices = new Map<string, ModelOption>();
  for (const entry of result.models) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim()) continue;
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    const ref = modelRef(entry.id, provider);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name : entry.id;
    choices.set(ref, {
      ref,
      label: provider ? `${name} · ${provider}` : name,
      available: entry.available !== false && entry.selectable !== false,
      ...normalizeThinkingMetadata(entry),
    });
  }
  return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export async function loadSessionModels(
  request: GatewayRequest,
  agentId: string,
  sessionKey: string
): Promise<ModelOption[]> {
  let result: any;
  try {
    result = await request('models.list', {
      agentId,
      sessionKey: toGatewaySessionKey(agentId, sessionKey),
      view: 'configured',
    });
  } catch (error: any) {
    // Older Gateways only accept an empty models.list parameter object.
    if (
      !/invalid.*(param|request)|additional propert|unexpected|unrecognized|unknown.*(field|propert)/i.test(
        error?.message || String(error)
      )
    )
      throw error;
    result = await request('models.list', {});
  }
  return normalizeModels(result);
}

export async function changeSessionModel(
  request: GatewayRequest,
  key: string,
  selection: string,
  agentId = 'main'
): Promise<ThinkingMetadata & { model: string; modelProvider: string; thinkingLevel?: string }> {
  // Explicit keys keep short session names scoped to the selected non-default agent,
  // including on older Gateways whose sessions.patch schema has no agentId field.
  const targetKey = toGatewaySessionKey(agentId, key);
  const result = await request('sessions.patch', { key: targetKey, model: selection || null });
  if (result?.ok === false)
    throw new Error(result.error?.message || 'The Gateway rejected the model change.');
  const resolved = result?.resolved;
  const entry = result?.entry;
  const selectedSlash = selection.indexOf('/');
  const provider =
    resolved?.modelProvider ??
    entry?.providerOverride ??
    entry?.modelProvider ??
    (selectedSlash >= 0 ? selection.slice(0, selectedSlash) : '');
  const model =
    resolved?.model ??
    entry?.modelOverride ??
    entry?.model ??
    (selectedSlash >= 0 ? selection.slice(selectedSlash + 1) : selection);
  return {
    model: typeof model === 'string' ? model : '',
    modelProvider: typeof provider === 'string' ? provider : '',
    // Explicit undefined clears capability data belonging to the previous model.
    thinkingLevels: undefined,
    thinkingDefault: undefined,
    ...normalizeThinkingMetadata(entry),
    ...normalizeThinkingMetadata(resolved),
    ...(Object.prototype.hasOwnProperty.call(entry || {}, 'thinkingLevel')
      ? { thinkingLevel: typeof entry.thinkingLevel === 'string' ? entry.thinkingLevel : '' }
      : {}),
  };
}

// Preserve the Gateway's option order and IDs: labels are presentation, IDs are wire values.
export function normalizeThinkingMetadata(source: any): ThinkingMetadata {
  const raw = Array.isArray(source?.thinkingLevels)
    ? source.thinkingLevels
    : Array.isArray(source?.thinkingOptions)
      ? source.thinkingOptions
      : undefined;
  const result: ThinkingMetadata = {};
  if (!raw && source?.reasoning === false) {
    result.thinkingLevels = [{ id: 'off', label: 'None' }];
  }
  if (raw) {
    const options = new Map<string, ThinkingOption>();
    for (const entry of raw) {
      const id =
        typeof entry === 'string'
          ? entry.trim()
          : typeof entry?.id === 'string'
            ? entry.id.trim()
            : '';
      if (!id) continue;
      const label =
        typeof entry?.label === 'string' && entry.label.trim()
          ? entry.label.trim()
          : thinkingLevelLabel(id);
      if (!options.has(id)) options.set(id, { id, label });
    }
    // An explicit empty list means no advertised choices, not an older Gateway.
    result.thinkingLevels = [...options.values()];
  }
  if (typeof source?.thinkingDefault === 'string') result.thinkingDefault = source.thinkingDefault;
  return result;
}

export function thinkingLevelLabel(level: string): string {
  if (level === 'off' || level === 'none') return 'None';
  if (!level) return 'Default';
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function sessionThinkingMetadata(session: any, defaults: any): ThinkingMetadata {
  const own = normalizeThinkingMetadata(session);
  const sameModel =
    !session?.model ||
    modelRef(session.model, session.modelProvider) ===
      modelRef(defaults?.model, defaults?.modelProvider);
  return { ...(sameModel ? normalizeThinkingMetadata(defaults) : {}), ...own };
}

export function reasoningOptions(metadata: ThinkingMetadata, current = ''): ThinkingOption[] {
  if (metadata.thinkingLevels !== undefined) return metadata.thinkingLevels;
  const legacy = ['off', 'minimal', 'low', 'medium', 'high'];
  if (current && !legacy.includes(current)) legacy.push(current);
  return legacy.map((id) => ({ id, label: thinkingLevelLabel(id) }));
}

export async function loadSessionThinking(
  request: GatewayRequest,
  agentId: string,
  key: string
): Promise<ThinkingMetadata & { thinkingLevel?: string }> {
  const listing = await request('sessions.list', { agentId, limit: 100 });
  const target = toGatewaySessionKey(agentId, key);
  const row = Array.isArray(listing?.sessions)
    ? listing.sessions.find(
        (entry: any) =>
          typeof entry?.key === 'string' &&
          toGatewaySessionKey(sessionAgentId(entry.key, entry.agentId || agentId), entry.key) ===
            target
      )
    : undefined;
  if (!row) return {};
  return {
    ...sessionThinkingMetadata(row, listing.defaults),
    ...(Object.prototype.hasOwnProperty.call(row, 'thinkingLevel')
      ? { thinkingLevel: typeof row.thinkingLevel === 'string' ? row.thinkingLevel : '' }
      : {}),
  };
}
