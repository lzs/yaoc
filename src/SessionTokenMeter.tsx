import { SessionInfo } from './types';

function tokenCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const compact = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export default function SessionTokenMeter({ session }: { session?: SessionInfo }) {
  const total = tokenCount(session?.totalTokens);
  const capacity = tokenCount(session?.contextTokens);
  const input = tokenCount(session?.inputTokens);
  const output = tokenCount(session?.outputTokens);
  const percent =
    total !== undefined && capacity !== undefined && capacity > 0
      ? (total / capacity) * 100
      : undefined;
  const tone =
    percent === undefined ? 'unknown' : percent > 85 ? 'high' : percent >= 60 ? 'medium' : 'low';
  const exact = (value: number | undefined) => value?.toLocaleString() ?? 'Unavailable';
  const details = [
    'Latest Gateway-reported token usage',
    `Total: ${exact(total)}`,
    `Context capacity: ${capacity ? exact(capacity) : 'Unavailable'}`,
    `Input: ${exact(input)}`,
    `Output: ${exact(output)}`,
    'Updates when session metadata refreshes; excludes any cost estimate.',
  ].join('\n');

  return (
    <span className={`session-token-meter token-${tone}`} tabIndex={0} aria-label={details}>
      <span className="session-token-dot" aria-hidden="true" />
      <span>
        {total === undefined ? 'Tokens unavailable' : `Tokens: ${compact.format(total)}`}
        {total !== undefined && capacity !== undefined && capacity > 0
          ? ` / ${compact.format(capacity)}`
          : ''}
        {percent !== undefined ? ` (${Math.round(percent)}%)` : ''}
      </span>
      <span className="session-token-tooltip" aria-hidden="true">
        {details}
      </span>
    </span>
  );
}
