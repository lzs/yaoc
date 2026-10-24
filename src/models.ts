export interface ModelOption {
  ref: string;
  label: string;
  available: boolean;
}

export type GatewayRequest = (method: string, params?: any, timeoutMs?: number) => Promise<any>;

export function modelRef(model?: string, provider?: string): string {
  const id = model?.trim() || '';
  return id && provider && !id.startsWith(`${provider}/`) ? `${provider}/${id}` : id;
}

export function toGatewaySessionKey(agentId: string, sessionKey: string): string {
  const cleanAgent = agentId?.trim() || 'main';
  const cleanKey = sessionKey?.trim() || 'main';
  return cleanKey.startsWith('agent:') || cleanAgent === 'main'
    ? cleanKey
    : `agent:${cleanAgent}:${cleanKey}`;
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
    result = await request('models.list', { agentId, sessionKey, view: 'configured' });
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
): Promise<{ model: string; modelProvider: string }> {
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
  };
}
