import type { SessionInfo } from './types';
import { toGatewaySessionKey, type GatewayRequest } from './models';

type PinMetadata = Pick<SessionInfo, 'pinned' | 'pinnedAt'>;

export function isSessionPinned(session: PinMetadata): boolean {
  if (typeof session.pinned === 'boolean') return session.pinned;
  return (
    typeof session.pinnedAt === 'number' &&
    Number.isFinite(session.pinnedAt) &&
    session.pinnedAt > 0
  );
}

// Omitted fields on partial events leave existing pin metadata alone; null clears it.
export function sessionPinPatch(source: any): Partial<PinMetadata> {
  const metadata = { ...source?.entry, ...source };
  if (!Object.hasOwn(metadata, 'pinned') && !Object.hasOwn(metadata, 'pinnedAt')) return {};
  const pinned = isSessionPinned(metadata);
  return {
    pinned,
    pinnedAt:
      pinned &&
      typeof metadata.pinnedAt === 'number' &&
      Number.isFinite(metadata.pinnedAt) &&
      metadata.pinnedAt > 0
        ? metadata.pinnedAt
        : undefined,
  };
}

// Stable grouping keeps the Gateway's order within each group.
export function sortPinnedSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [
    ...sessions.filter(isSessionPinned),
    ...sessions.filter((session) => !isSessionPinned(session)),
  ];
}

export async function changeSessionPin(
  request: GatewayRequest,
  session: SessionInfo,
  pinned: boolean
): Promise<PinMetadata> {
  const key = toGatewaySessionKey(session.agentId, session.key);
  try {
    const result = await request('sessions.patch', {
      key,
      pinned,
      ...(session.sessionId ? { expectedSessionId: session.sessionId } : {}),
    });
    if (result?.ok === false)
      throw new Error(result.error?.message || 'The Gateway rejected the pin change.');
    const entry = result?.entry;
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      isSessionPinned(entry) !== pinned
    )
      throw new Error(
        'The Gateway did not confirm the pin change. Refresh sessions and check that this OpenClaw version supports pins.'
      );
    if (typeof result.key === 'string' && toGatewaySessionKey(session.agentId, result.key) !== key)
      throw new Error('The Gateway returned a pin change for a different session.');
    return { pinned, pinnedAt: sessionPinPatch(entry).pinnedAt };
  } catch (error: any) {
    const message = error?.message || String(error);
    if (
      (/pinned|pinnedAt/i.test(message) &&
        /unknown|unexpected|additional|unrecognized|not supported/i.test(message)) ||
      /unknown method.*sessions\.patch/i.test(message)
    )
      throw new Error(
        'This Gateway does not support session pins. Update OpenClaw to use this feature.'
      );
    throw error;
  }
}
