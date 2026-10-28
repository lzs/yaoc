import { useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { UpdateInfo } from './types';

export default function UpdateSettings({ restartBlocked }: { restartBlocked: boolean }) {
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<'check' | 'download' | 'install' | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const api = window.openclawApi;
  const run = async (action: 'check' | 'download' | 'install') => {
    if (busy) return;
    if (action === 'install' && restartBlocked) return;
    if (
      action === 'install' &&
      !window.confirm(
        'Restart YAOC to apply the verified update? A recovery copy of the current executable will be kept beside it.'
      )
    )
      return;
    setBusy(action);
    setError(false);
    setMessage('');
    try {
      if (action === 'check') {
        setReady(false);
        setUpdate(null);
        if (!api?.checkForUpdate)
          throw new Error('Update checks are available in the Windows app.');
        const found = await api.checkForUpdate();
        setUpdate(found);
        setMessage(
          found
            ? `YAOC ${found.version} is available (${(found.size / 1048576).toFixed(1)} MB).`
            : 'You are up to date with official releases.'
        );
      } else if (action === 'download') {
        if (!api?.downloadUpdate) throw new Error('Update downloads are unavailable.');
        await api.downloadUpdate();
        setReady(true);
        setMessage('Download verified. Ready to update and restart.');
      } else {
        if (!api?.installUpdate) throw new Error('Update installation is unavailable.');
        await api.installUpdate();
        setMessage('Restarting YAOC…');
      }
    } catch (err) {
      setError(true);
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="form-row" style={{ marginTop: 12 }}>
      <label>Updates</label>
      <p className="settings-help">
        Check GitHub for official releases. Updates keep this app portable and preserve its
        filename.
        {__APP_CHANNEL__ === 'beta' &&
          ' This Beta checks official releases only; it will not install a different Beta.'}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="btn btn-secondary" disabled={!!busy} onClick={() => void run('check')}>
          <RefreshCw size={14} className={busy === 'check' ? 'spin-icon' : undefined} />
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
        {update && !ready && (
          <button
            className="btn btn-primary"
            disabled={!!busy}
            onClick={() => void run('download')}
          >
            <Download size={14} />
            {busy === 'download' ? 'Downloading and verifying…' : 'Download update'}
          </button>
        )}
        {ready && (
          <button
            className="btn btn-primary"
            disabled={!!busy || restartBlocked}
            onClick={() => void run('install')}
          >
            {busy === 'install' ? 'Restarting…' : 'Update and restart'}
          </button>
        )}
        <button
          className="btn btn-secondary"
          onClick={() =>
            void api?.openExternalUrl?.(
              update?.releaseUrl || 'https://github.com/lzs/yaoc/releases/latest'
            )
          }
        >
          GitHub releases
        </button>
      </div>
      {message && (
        <p
          className="settings-help"
          role={error ? 'alert' : 'status'}
          style={error ? { color: 'var(--text-warning)' } : undefined}
        >
          {message}
        </p>
      )}
      {ready && restartBlocked && (
        <p className="settings-help">
          Save file changes, send or clear drafts and attachments in all sessions, and wait for
          active responses before restarting.
        </p>
      )}
    </div>
  );
}
