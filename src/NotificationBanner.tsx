import { useEffect, useState } from 'react';
export default function NotificationBanner() {
  const [notification, setNotification] = useState<{ title: string; body: string } | null>(null);
  useEffect(() => window.openclawApi?.onNotification?.(setNotification), []);
  if (!notification) return null;
  return (
    <div className="notification-banner" role="status">
      <strong>{notification.title}</strong>
      <p>{notification.body}</p>
      <button className="btn btn-secondary" onClick={() => setNotification(null)}>
        Dismiss
      </button>
    </div>
  );
}
