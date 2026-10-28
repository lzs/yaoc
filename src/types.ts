export interface GatewayProfile {
  id: string;
  name: string;
  endpoint: string;
  token?: string;
  password?: string;
  deviceToken?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  allowInsecureTls?: boolean;
  includeDeviceIdentity?: boolean;
}

export interface AgentInfo {
  id: string;
  name?: string;
  workspace?: string;
}

export interface ThinkingOption {
  id: string;
  label: string;
}

export interface ThinkingMetadata {
  thinkingLevels?: ThinkingOption[];
  thinkingDefault?: string;
}

export interface SessionInfo extends ThinkingMetadata {
  key: string;
  agentId: string;
  sessionId?: string;
  label?: string | null;
  displayName?: string | null;
  derivedTitle?: string | null;
  kind?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  updatedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  channel?: string;
  lastChannel?: string;
}

export interface ToolCallItem {
  id: string;
  name: string;
  status?: 'running' | 'completed' | 'error';
  args?: any;
  result?: any;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  startedAt?: number;
  endedAt?: number;
}

export interface ChatAttachmentItem {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  origin: 'paste' | 'file';
  isImage: boolean;
  base64?: string;
  previewUrl?: string;
  width?: number;
  height?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallItem[];
  attachments?: ChatAttachmentItem[];
  timestamp: number;
  streaming?: boolean;
  runId?: string;
  error?: boolean;
}

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind?: 'file' | 'directory';
  size?: number;
  updatedAt?: number;
  missing?: boolean;
}

export interface ExecApprovalRequest {
  id: string;
  sessionKey?: string;
  agentId?: string;
  command: string;
  cwd?: string;
  reason?: string;
  receivedAt: number;
}

export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'pairing' | 'error';
  profileId?: string;
  endpoint?: string;
  message?: string;
  code?: string;
  details?: any;
  deviceId?: string;
  hello?: any;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  runtime?: string;
  encryptedStorage?: boolean;
  deviceIdentity?: {
    deviceId: string;
    publicKey: string;
  };
}

export interface PromptTemplate {
  id: string;
  trigger: string;
  label: string;
  template: string;
  isBuiltIn?: boolean;
}

export interface UiSessionState {
  autoConnect?: boolean;
  selectedAgentId?: string;
  selectedSessionKey?: string;
  showWorkspacePane?: boolean;
  currentDir?: string;
  activeFileName?: string;
  showHiddenFiles?: boolean;
  sidebarWidth?: number;
  workspaceWidth?: number;
  workspaceTreeWidth?: number;
  globalHotkey?: string;
  notificationsEnabled?: boolean;
  notificationSound?: boolean;
  promptTemplates?: PromptTemplate[];
}

export interface UpdateInfo {
  version: string;
  releaseUrl: string;
  size: number;
}

declare global {
  const __APP_VERSION_LABEL__: string;
  const __APP_BUILD_TIMESTAMP__: string;
  const __APP_CHANNEL__: 'official' | 'beta';

  interface Window {
    openclawApi?: {
      checkForUpdate?: () => Promise<UpdateInfo | null>;
      downloadUpdate?: () => Promise<void>;
      installUpdate?: () => Promise<void>;
      getSystemInfo: () => Promise<SystemInfo>;
      loadProfiles: () => Promise<{
        profiles: GatewayProfile[];
        activeProfileId: string;
        uiState?: UiSessionState;
      }>;
      saveProfiles: (
        profiles: GatewayProfile[],
        activeProfileId: string,
        uiState?: UiSessionState
      ) => Promise<{ ok: boolean }>;
      connect: (profile: GatewayProfile) => Promise<any>;
      disconnect: () => Promise<{ ok: boolean }>;
      request: (method: string, params?: any, timeoutMs?: number) => Promise<any>;
      setGlobalHotkey?: (hotkey: string) => Promise<{ ok: boolean; hotkey: string }>;
      quitApp?: () => Promise<void>;
      windowAction?: (
        action: 'minimize' | 'toggleMaximize' | 'close' | 'startDragging'
      ) => Promise<void>;
      getWindowMaximized?: () => Promise<boolean>;
      onWindowMaximized?: (callback: (maximized: boolean) => void) => () => void;

      openExternalUrl?: (url: string) => Promise<{ ok: boolean }>;
      setTaskbarProgress?: (
        status?: 'none' | 'normal' | 'indeterminate' | 'paused' | 'error',
        progress?: number
      ) => Promise<void>;
      showNotification?: (title: string, body: string, sound?: boolean) => Promise<void>;
      playNotificationSound?: (soundType?: 'info' | 'warning' | 'error') => Promise<void>;
      requestAttention?: (level?: 'informational' | 'critical' | 'none') => Promise<void>;
      onStatus: (callback: (status: ConnectionStatus) => void) => () => void;
      onGatewayEvent: (callback: (frame: any) => void) => () => void;
    };
  }
}
