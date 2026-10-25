import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Bot,
  Check,
  CornerLeftUp,
  Cpu,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  Pencil,
  Play,
  Plug,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import {
  AgentInfo,
  ChatAttachmentItem,
  ChatMessage,
  ConnectionStatus,
  ExecApprovalRequest,
  GatewayProfile,
  SessionInfo,
  SystemInfo,
  ToolCallItem,
  UiSessionState,
  WorkspaceFileEntry,
} from './types';

import { applyTheme, loadTheme, saveTheme, Theme } from './theme';
import SessionModelSwitcher from './SessionModelSwitcher';
import {
  normalizeSessions,
  sessionAgentId,
  sessionThinkingMetadata,
  toGatewaySessionKey,
} from './models';
import { hasMarkdownSyntax, MarkdownContent } from './markdown';

const YAOC_ICON_URL = new URL('./assets/yaoc.svg', import.meta.url).href;

const UI_STATE_STORAGE_KEY = 'openclaw.uiState.v1';

function loadLocalUiState(): UiSessionState {
  try {
    const raw = localStorage.getItem(UI_STATE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Ignore storage read errors
  }
  return {};
}

const STANDARD_WORKSPACE_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'IDENTITY.md',
  'MEMORY.md',
  'TOOLS.md',
  'HEARTBEAT.md',
];

function extractMessageText(rawContent: any): string {
  if (typeof rawContent === 'string') return rawContent;
  if (Array.isArray(rawContent)) {
    return rawContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (rawContent && typeof rawContent.text === 'string') return rawContent.text;
  return '';
}

function extractMessageAttachments(rawMsg: any): ChatAttachmentItem[] {
  const result: ChatAttachmentItem[] = [];
  const rawContent = rawMsg?.content;

  if (Array.isArray(rawContent)) {
    rawContent.forEach((part: any, i: number) => {
      if (!part || typeof part !== 'object') return;
      if (part.type === 'image') {
        const mimeType = part.mimeType || part.source?.media_type || part.mediaType || 'image/png';
        const b64 =
          typeof part.data === 'string'
            ? part.data
            : typeof part.source?.data === 'string'
              ? part.source.data
              : '';
        const url =
          typeof part.url === 'string'
            ? part.url
            : typeof part.image_url?.url === 'string'
              ? part.image_url.url
              : b64
                ? b64.startsWith('data:')
                  ? b64
                  : `data:${mimeType};base64,${b64}`
                : '';
        if (url) {
          result.push({
            id: `hist-img-${i}-${Date.now()}`,
            fileName: part.fileName || `image-${i + 1}.png`,
            mimeType,
            sizeBytes: part.sizeBytes || (b64 ? Math.floor((b64.length * 3) / 4) : 0),
            origin: 'file',
            isImage: true,
            previewUrl: url,
            width: typeof part.width === 'number' ? part.width : undefined,
            height: typeof part.height === 'number' ? part.height : undefined,
          });
        }
      } else if (part.type === 'image_url' && typeof part.image_url?.url === 'string') {
        result.push({
          id: `hist-imgurl-${i}-${Date.now()}`,
          fileName: `image-${i + 1}.png`,
          mimeType: 'image/png',
          sizeBytes: 0,
          origin: 'file',
          isImage: true,
          previewUrl: part.image_url.url,
        });
      }
    });
  }

  const mediaList =
    (Array.isArray(rawMsg?.attachments) && rawMsg.attachments) ||
    (Array.isArray(rawMsg?.media) && rawMsg.media) ||
    (Array.isArray(rawMsg?.__openclaw?.media) && rawMsg.__openclaw.media) ||
    [];

  mediaList.forEach((att: any, i: number) => {
    if (!att || typeof att !== 'object') return;
    const mimeType = att.mimeType || att.contentType || 'application/octet-stream';
    const isImage = mimeType.startsWith('image/') || att.kind === 'image';
    const fileName = att.fileName || att.label || `attachment-${i + 1}`;
    if (isImage && result.some((r) => r.fileName === fileName && r.previewUrl)) {
      return;
    }
    const b64 =
      typeof att.content === 'string' ? att.content : typeof att.data === 'string' ? att.data : '';
    const previewUrl =
      isImage && b64
        ? b64.startsWith('data:')
          ? b64
          : `data:${mimeType};base64,${b64}`
        : isImage &&
            typeof att.url === 'string' &&
            (att.url.startsWith('data:') || att.url.startsWith('http'))
          ? att.url
          : undefined;
    result.push({
      id: `hist-att-${i}-${Date.now()}`,
      fileName,
      mimeType,
      sizeBytes: typeof att.sizeBytes === 'number' ? att.sizeBytes : 0,
      origin: att.origin === 'paste' ? 'paste' : 'file',
      isImage,
      previewUrl,
    });
  });

  return result;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/jsonl',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  py: 'text/x-python',
  rs: 'text/plain',
  sh: 'text/x-shellscript',
  ps1: 'text/plain',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

function inferMimeType(fileName: string, browserMime?: string): string {
  if (browserMime && browserMime.trim() && browserMime !== 'application/octet-stream') {
    return browserMime.trim();
  }
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  return MIME_BY_EXT[ext] || browserMime || 'application/octet-stream';
}

function formatByteSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function readFileAsAttachment(
  file: File,
  origin: 'paste' | 'file'
): Promise<ChatAttachmentItem> {
  const MAX_NON_IMAGE_BYTES = 20 * 1024 * 1024;
  const MAX_SAFE_IMAGE_BYTES = 4.6 * 1024 * 1024; // OpenClaw MAX_IMAGE_BYTES is 6 MB

  let fileName = file.name?.trim() || '';
  const mimeType = inferMimeType(fileName, file.type);
  const isImage = mimeType.startsWith('image/');

  if (!fileName || (origin === 'paste' && /^image\.(png|jpe?g|webp|gif)$/i.test(fileName))) {
    const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || (isImage ? 'png' : 'bin');
    const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
    fileName = `pasted-${stamp}.${ext}`;
  }

  if (!isImage && file.size > MAX_NON_IMAGE_BYTES) {
    throw new Error(`File "${fileName}" exceeds 20 MB limit (${formatByteSize(file.size)}).`);
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(`Could not read file "${fileName}"`));
    reader.readAsDataURL(file);
  });

  if (isImage && mimeType !== 'image/svg+xml') {
    const imgInfo = await new Promise<{
      width: number;
      height: number;
      finalDataUrl: string;
      finalMime: string;
    }>((resolve) => {
      const img = new window.Image();
      img.onload = () => {
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        const needsCompress =
          mimeType !== 'image/gif' && (file.size > MAX_SAFE_IMAGE_BYTES || w > 3840 || h > 3840);
        if (!needsCompress) {
          resolve({ width: w, height: h, finalDataUrl: dataUrl, finalMime: mimeType });
          return;
        }
        const maxDim = 2560;
        const scale = Math.min(1, maxDim / Math.max(w || 1, h || 1));
        const targetW = Math.max(1, Math.round(w * scale));
        const targetH = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, targetW, targetH);
          const compressedUrl = canvas.toDataURL('image/jpeg', 0.86);
          const renamed = fileName.replace(/\.[a-zA-Z0-9]+$/, '.jpg');
          fileName = renamed;
          resolve({
            width: targetW,
            height: targetH,
            finalDataUrl: compressedUrl,
            finalMime: 'image/jpeg',
          });
        } else {
          resolve({ width: w, height: h, finalDataUrl: dataUrl, finalMime: mimeType });
        }
      };
      img.onerror = () =>
        resolve({ width: 0, height: 0, finalDataUrl: dataUrl, finalMime: mimeType });
      img.src = dataUrl;
    });

    const commaIdx = imgInfo.finalDataUrl.indexOf(',');
    const b64 = commaIdx >= 0 ? imgInfo.finalDataUrl.slice(commaIdx + 1) : imgInfo.finalDataUrl;
    const approxBytes = Math.floor((b64.length * 3) / 4);

    return {
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      fileName,
      mimeType: imgInfo.finalMime,
      sizeBytes: approxBytes || file.size,
      origin,
      isImage: true,
      base64: b64,
      previewUrl: imgInfo.finalDataUrl,
      width: imgInfo.width || undefined,
      height: imgInfo.height || undefined,
    };
  }

  const commaIdx = dataUrl.indexOf(',');
  const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fileName,
    mimeType,
    sizeBytes: file.size,
    origin,
    isImage,
    base64: b64,
    previewUrl: isImage ? dataUrl : undefined,
  };
}

function getSessionDisplayName(s: SessionInfo): string {
  if (typeof s?.label === 'string' && s.label.trim()) return s.label.trim();
  if (typeof s?.displayName === 'string' && s.displayName.trim()) return s.displayName.trim();
  if (typeof s?.derivedTitle === 'string' && s.derivedTitle.trim()) return s.derivedTitle.trim();
  const rawKey = typeof s?.key === 'string' ? s.key : 'main';
  return rawKey.replace(/^agent:[^:]+:/, '') || rawKey;
}

export default function App() {
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string>('local-default');
  const [profilesLoaded, setProfilesLoaded] = useState<boolean>(false);
  const [autoConnect, setAutoConnect] = useState<boolean>(() =>
    Boolean(loadLocalUiState().autoConnect)
  );
  const [connStatus, setConnStatus] = useState<ConnectionStatus>({ state: 'disconnected' });
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'general' | 'gateway'>('general');
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const settingsDialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme(theme);
    update();
    saveTheme(theme);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);

  useEffect(() => {
    if (!showProfileModal) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    settingsDialogRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.focus();
    return () => previousFocus?.focus();
  }, [showProfileModal]);

  // Agents & Sessions (hydrated from last session state)
  const [agents, setAgents] = useState<AgentInfo[]>(() => {
    const savedAgent = loadLocalUiState().selectedAgentId || 'main';
    return savedAgent !== 'main'
      ? [
          { id: savedAgent, name: savedAgent },
          { id: 'main', name: 'main' },
        ]
      : [{ id: 'main', name: 'main' }];
  });
  const [selectedAgentId, setSelectedAgentId] = useState<string>(
    () => loadLocalUiState().selectedAgentId || 'main'
  );
  const [sessions, setSessions] = useState<SessionInfo[]>(() => {
    const saved = loadLocalUiState();
    const sKey = saved.selectedSessionKey || 'main';
    const aId = saved.selectedAgentId || 'main';
    return normalizeSessions(
      sKey !== 'main'
        ? [
            { key: sKey, agentId: aId, label: sKey },
            { key: 'main', agentId: aId, label: 'Primary Session' },
          ]
        : [{ key: 'main', agentId: aId, label: 'Primary Session' }],
      aId
    );
  });
  const [selectedSessionKey, setSelectedSessionKey] = useState<string>(() =>
    toGatewaySessionKey(
      loadLocalUiState().selectedAgentId || 'main',
      loadLocalUiState().selectedSessionKey || 'main'
    )
  );
  const [newSessionKeyInput, setNewSessionKeyInput] = useState<string>('');
  const [showNewSessionInput, setShowNewSessionInput] = useState(false);
  const [sessionMenu, setSessionMenu] = useState<{
    sessionKey: string;
    session: SessionInfo;
    x: number;
    y: number;
  } | null>(null);
  const [renamingSessionKey, setRenamingSessionKey] = useState<string | null>(null);
  const [renameSessionInput, setRenameSessionInput] = useState<string>('');
  const [refreshingSessions, setRefreshingSessions] = useState<boolean>(false);
  const localSessionLabelsRef = useRef(new Map<string, string>());

  // Chat State
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [profileStorageError, setProfileStorageError] = useState('');
  const composerSessionKey = `${activeProfileId}:${toGatewaySessionKey(selectedAgentId, selectedSessionKey)}`;
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; attachments: ChatAttachmentItem[] }>
  >({});
  const composerText = drafts[composerSessionKey]?.text || '';
  const pendingAttachments = drafts[composerSessionKey]?.attachments || [];
  function setComposerText(text: string) {
    setDrafts((prev) => ({
      ...prev,
      [composerSessionKey]: {
        text,
        attachments: prev[composerSessionKey]?.attachments || [],
      },
    }));
  }
  function setPendingAttachments(update: React.SetStateAction<ChatAttachmentItem[]>) {
    setDrafts((prev) => ({
      ...prev,
      [composerSessionKey]: {
        text: prev[composerSessionKey]?.text || '',
        attachments:
          typeof update === 'function'
            ? update(prev[composerSessionKey]?.attachments || [])
            : update,
      },
    }));
  }
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sessionListRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    sessionListRef.current
      ?.querySelector<HTMLElement>('.session-item.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selectedSessionKey, sessions]);
  useLayoutEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }, [composerText]);
  const [isDraggingOverChat, setIsDraggingOverChat] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<{ url: string; fileName: string } | null>(
    null
  );
  const [showQuitConfirmModal, setShowQuitConfirmModal] = useState(false);
  const [globalHotkey, setGlobalHotkey] = useState<string>(() => {
    const saved = loadLocalUiState();
    return typeof saved.globalHotkey === 'string' ? saved.globalHotkey : 'Alt+Shift+3';
  });
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);
  const [hotkeyStatusMsg, setHotkeyStatusMsg] = useState<{ text: string; error?: boolean } | null>(
    null
  );
  const [isChangingModel, setIsChangingModel] = useState(false);
  const sessionRunIdsRef = useRef(new Map<string, string>());
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef<number>(0);

  // Approvals State
  const [approvals, setApprovals] = useState<ExecApprovalRequest[]>([]);

  // Workspace Files Drawer State (hydrated from last session state)
  const [showWorkspacePane, setShowWorkspacePane] = useState<boolean>(() => {
    const saved = loadLocalUiState();
    return typeof saved.showWorkspacePane === 'boolean' ? saved.showWorkspacePane : true;
  });
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = loadLocalUiState();
    return typeof saved.sidebarWidth === 'number' && saved.sidebarWidth >= 180
      ? saved.sidebarWidth
      : 270;
  });
  const [workspaceWidth, setWorkspaceWidth] = useState<number>(() => {
    const saved = loadLocalUiState();
    return typeof saved.workspaceWidth === 'number' && saved.workspaceWidth >= 300
      ? saved.workspaceWidth
      : 560;
  });
  const [workspaceTreeWidth, setWorkspaceTreeWidth] = useState<number>(() => {
    const saved = loadLocalUiState().workspaceTreeWidth;
    return typeof saved === 'number' && Number.isFinite(saved)
      ? Math.max(120, Math.min(600, saved))
      : 210;
  });
  const workspaceSplitRef = useRef<HTMLDivElement | null>(null);
  const [resizingPane, setResizingPane] = useState<
    'sidebar' | 'workspace' | 'workspace-tree' | null
  >(null);
  const [workspaceRootPath, setWorkspaceRootPath] = useState<string>(
    '/home/openclaw/.openclaw/workspace'
  );
  const [currentDir, setCurrentDir] = useState<string>(() => loadLocalUiState().currentDir || '');
  const [showHiddenFiles, setShowHiddenFiles] = useState<boolean>(() =>
    Boolean(loadLocalUiState().showHiddenFiles)
  );
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFileEntry[]>([]);
  const [activeFileName, setActiveFileName] = useState<string>(
    () => loadLocalUiState().activeFileName || 'AGENTS.md'
  );
  const [fileContent, setFileContent] = useState<string>('');
  const [savedFileContent, setSavedFileContent] = useState<string>('');
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileStatusMsg, setFileStatusMsg] = useState<string>('');
  const [showNewFileInput, setShowNewFileInput] = useState(false);
  const [newFileNameInput, setNewFileNameInput] = useState('');

  // Pairing & Onboarding Guide State
  const [autoPollPairing, setAutoPollPairing] = useState(true);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);
  const [useDockerCmds, setUseDockerCmds] = useState(false);
  const [rawMessageIds, setRawMessageIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionKeys, setUnreadSessionKeys] = useState<Set<string>>(() => new Set());
  const [streamingSessionKeys, setStreamingSessionKeys] = useState<Set<string>>(() => new Set());
  const streamingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const isStreaming = streamingSessionKeys.has(
    toGatewaySessionKey(selectedAgentId, selectedSessionKey)
  );

  function markSessionStreaming(gatewayKey: string, streaming: boolean) {
    if (!gatewayKey) return;
    if (!streaming) sessionRunIdsRef.current.delete(gatewayKey);
    const prevTimer = streamingTimeoutsRef.current.get(gatewayKey);
    if (prevTimer) {
      clearTimeout(prevTimer);
      streamingTimeoutsRef.current.delete(gatewayKey);
    }
    if (streaming) {
      setStreamingSessionKeys((prev) => {
        if (prev.has(gatewayKey)) return prev;
        const next = new Set(prev);
        next.add(gatewayKey);
        return next;
      });
      const timer = setTimeout(() => {
        streamingTimeoutsRef.current.delete(gatewayKey);
        sessionRunIdsRef.current.delete(gatewayKey);
        setStreamingSessionKeys((prev) => {
          if (!prev.has(gatewayKey)) return prev;
          const next = new Set(prev);
          next.delete(gatewayKey);
          return next;
        });
      }, 45000);
      streamingTimeoutsRef.current.set(gatewayKey, timer);
    } else {
      setStreamingSessionKeys((prev) => {
        if (!prev.has(gatewayKey)) return prev;
        const next = new Set(prev);
        next.delete(gatewayKey);
        return next;
      });
    }
  }

  function markSessionUnread(gatewayKey: string, unread: boolean) {
    if (!gatewayKey) return;
    setUnreadSessionKeys((prev) => {
      if (unread) {
        if (prev.has(gatewayKey)) return prev;
        const next = new Set(prev);
        next.add(gatewayKey);
        return next;
      } else {
        if (!prev.has(gatewayKey)) return prev;
        const next = new Set(prev);
        next.delete(gatewayKey);
        return next;
      }
    });
  }

  function toggleRawMessage(msgId: string) {
    setRawMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(msgId)) {
        next.delete(msgId);
      } else {
        next.add(msgId);
      }
      return next;
    });
  }

  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];
  const activeProfileIdRef = useRef(activeProfileId);
  activeProfileIdRef.current = activeProfileId;
  const activeGatewaySessionKeyRef = useRef(
    toGatewaySessionKey(selectedAgentId, selectedSessionKey)
  );
  activeGatewaySessionKeyRef.current = toGatewaySessionKey(selectedAgentId, selectedSessionKey);
  const loadedSessionKeyRef = useRef<string | null>(null);
  const visitedSessionsRef = useRef<Set<string>>(new Set());
  const sessionScrollTopRef = useRef<Map<string, number>>(new Map());
  const pendingScrollActionRef = useRef<
    | { type: 'bottom'; sessionKey: string }
    | { type: 'restore'; sessionKey: string; scrollTop: number }
    | null
  >(null);
  const initialBottomLockUntilRef = useRef<{ sessionKey: string; expiresAt: number } | null>(null);
  const chatHistorySeqRef = useRef(0);
  const workspaceFileSeqRef = useRef(0);

  const uiStateRef = useRef<UiSessionState>({
    autoConnect,
    selectedAgentId,
    selectedSessionKey,
    showWorkspacePane,
    currentDir,
    activeFileName,
    showHiddenFiles,
    sidebarWidth,
    workspaceWidth,
    workspaceTreeWidth,
    globalHotkey,
  });

  useEffect(() => {
    const nextUiState: UiSessionState = {
      autoConnect,
      selectedAgentId,
      selectedSessionKey,
      showWorkspacePane,
      currentDir,
      activeFileName,
      showHiddenFiles,
      sidebarWidth,
      workspaceWidth,
      workspaceTreeWidth,
      globalHotkey,
    };
    uiStateRef.current = nextUiState;
    try {
      localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(nextUiState));
    } catch {
      // Ignore localStorage quota/access errors
    }
    if (!profilesLoaded || profiles.length === 0) return;
    const timer = setTimeout(() => {
      window.openclawApi
        ?.saveProfiles(profiles, activeProfileId, nextUiState)
        .then(() => setProfileStorageError(''))
        .catch((error: unknown) =>
          setProfileStorageError(
            `Could not save settings: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    }, 300);
    return () => clearTimeout(timer);
  }, [
    profilesLoaded,
    profiles,
    activeProfileId,
    autoConnect,
    selectedAgentId,
    selectedSessionKey,
    showWorkspacePane,
    currentDir,
    activeFileName,
    showHiddenFiles,
    sidebarWidth,
    workspaceWidth,
    workspaceTreeWidth,
    globalHotkey,
  ]);

  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopiedCmd(id);
    setTimeout(() => {
      setCopiedCmd((prev) => (prev === id ? null : prev));
    }, 1800);
  }

  // Auto-poll when in 'pairing' state (just like OpenClaw Web Control UI!)
  useEffect(() => {
    if (connStatus.state !== 'pairing' || !autoPollPairing || !activeProfile) return;
    const timer = setInterval(() => {
      window.openclawApi?.connect(activeProfile).catch(() => {});
    }, 4500);
    return () => clearInterval(timer);
  }, [connStatus.state, autoPollPairing, activeProfile]);

  function saveCurrentSessionScrollPosition() {
    const el = messagesContainerRef.current;
    const loadedKey = loadedSessionKeyRef.current;
    if (el && loadedKey) {
      sessionScrollTopRef.current.set(loadedKey, el.scrollTop);
    }
  }

  // Position chat at the bottom on first visit to a session in this app run,
  // or restore the last remembered scroll position on subsequent visits.
  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    const pending = pendingScrollActionRef.current;
    if (pending) {
      pendingScrollActionRef.current = null;
      if (pending.type === 'bottom') {
        el.scrollTop = el.scrollHeight;
        sessionScrollTopRef.current.set(pending.sessionKey, el.scrollTop);
        initialBottomLockUntilRef.current = {
          sessionKey: pending.sessionKey,
          expiresAt: Date.now() + 600,
        };
      } else {
        initialBottomLockUntilRef.current = null;
        const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(pending.scrollTop, maxTop);
        sessionScrollTopRef.current.set(pending.sessionKey, el.scrollTop);
      }
      return;
    }

    const lastMsg = messages[messages.length - 1];
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (lastMsg?.role === 'user' || distanceFromBottom < 150) {
      el.scrollTop = el.scrollHeight;
      if (loadedSessionKeyRef.current) {
        sessionScrollTopRef.current.set(loadedSessionKeyRef.current, el.scrollTop);
      }
    }
  }, [messages]);

  // Initial load of system info, profiles, persisted UI state & auto-connect
  useEffect(() => {
    const api = window.openclawApi;
    if (!api) return;

    const unsubStatus = api.onStatus((status) => {
      setConnStatus(status);
      if (status.state !== 'connected') {
        for (const timer of streamingTimeoutsRef.current.values()) clearTimeout(timer);
        streamingTimeoutsRef.current.clear();
        sessionRunIdsRef.current.clear();
        setStreamingSessionKeys(new Set());
      }
      if (status.state === 'connected') {
        setAutoConnect(true);
        const newDeviceToken = status.hello?.auth?.deviceToken;
        if (newDeviceToken && typeof newDeviceToken === 'string') {
          const currentActiveId = activeProfileIdRef.current;
          setProfiles((prev) =>
            prev.map((p) =>
              p.id === currentActiveId || (status.endpoint && p.endpoint === status.endpoint)
                ? { ...p, deviceToken: newDeviceToken }
                : p
            )
          );
        }
      }
    });

    api
      .getSystemInfo()
      .then(setSysInfo)
      .catch(() => {});
    api
      .loadProfiles()
      .then((res) => {
        setProfiles(res.profiles);
        setActiveProfileId(res.activeProfileId);

        const targetProfile =
          res.profiles.find((p) => p.id === res.activeProfileId) || res.profiles[0];
        const hasExistingAuth = Boolean(targetProfile?.deviceToken || targetProfile?.token);

        const localUi = loadLocalUiState();
        const fileUi = res.uiState || {};
        const mergedUi: UiSessionState = {
          autoConnect:
            typeof fileUi.autoConnect === 'boolean'
              ? fileUi.autoConnect
              : typeof localUi.autoConnect === 'boolean'
                ? localUi.autoConnect
                : hasExistingAuth,
          selectedAgentId: fileUi.selectedAgentId || localUi.selectedAgentId || 'main',
          selectedSessionKey: fileUi.selectedSessionKey || localUi.selectedSessionKey || 'main',
          showWorkspacePane:
            typeof fileUi.showWorkspacePane === 'boolean'
              ? fileUi.showWorkspacePane
              : typeof localUi.showWorkspacePane === 'boolean'
                ? localUi.showWorkspacePane
                : true,
          currentDir:
            typeof fileUi.currentDir === 'string' ? fileUi.currentDir : localUi.currentDir || '',
          activeFileName: fileUi.activeFileName || localUi.activeFileName || 'AGENTS.md',
          showHiddenFiles:
            typeof fileUi.showHiddenFiles === 'boolean'
              ? fileUi.showHiddenFiles
              : Boolean(localUi.showHiddenFiles),
          sidebarWidth:
            typeof fileUi.sidebarWidth === 'number'
              ? fileUi.sidebarWidth
              : typeof localUi.sidebarWidth === 'number'
                ? localUi.sidebarWidth
                : 270,
          workspaceTreeWidth: fileUi.workspaceTreeWidth ?? localUi.workspaceTreeWidth ?? 210,
          workspaceWidth:
            typeof fileUi.workspaceWidth === 'number'
              ? fileUi.workspaceWidth
              : typeof localUi.workspaceWidth === 'number'
                ? localUi.workspaceWidth
                : 560,
          globalHotkey:
            typeof fileUi.globalHotkey === 'string'
              ? fileUi.globalHotkey
              : typeof localUi.globalHotkey === 'string'
                ? localUi.globalHotkey
                : 'Alt+Shift+3',
        };

        mergedUi.selectedSessionKey = toGatewaySessionKey(
          mergedUi.selectedAgentId || 'main',
          mergedUi.selectedSessionKey || 'main'
        );
        uiStateRef.current = mergedUi;
        if (typeof mergedUi.globalHotkey === 'string') {
          setGlobalHotkey(mergedUi.globalHotkey);
          api.setGlobalHotkey?.(mergedUi.globalHotkey).catch(() => {});
        }
        setAutoConnect(Boolean(mergedUi.autoConnect));
        if (mergedUi.selectedAgentId) {
          setSelectedAgentId(mergedUi.selectedAgentId);
          setAgents((prev) =>
            prev.some((a) => a.id === mergedUi.selectedAgentId)
              ? prev
              : [{ id: mergedUi.selectedAgentId!, name: mergedUi.selectedAgentId! }, ...prev]
          );
        }
        if (mergedUi.selectedSessionKey) {
          const key = mergedUi.selectedSessionKey;
          const agentId = mergedUi.selectedAgentId || 'main';
          setSelectedSessionKey(key);
          setSessions((prev) =>
            normalizeSessions(
              prev.some((s) => toGatewaySessionKey(s.agentId || agentId, s.key) === key)
                ? prev
                : [{ key, agentId, label: key.replace(/^agent:[^:]+:/, '') }, ...prev],
              agentId
            )
          );
        }
        if (typeof mergedUi.showWorkspacePane === 'boolean') {
          setShowWorkspacePane(mergedUi.showWorkspacePane);
        }
        if (typeof mergedUi.currentDir === 'string') {
          setCurrentDir(mergedUi.currentDir);
        }
        if (mergedUi.activeFileName) {
          setActiveFileName(mergedUi.activeFileName);
        }
        if (typeof mergedUi.showHiddenFiles === 'boolean') {
          setShowHiddenFiles(mergedUi.showHiddenFiles);
        }
        if (typeof mergedUi.sidebarWidth === 'number' && mergedUi.sidebarWidth >= 180) {
          setSidebarWidth(mergedUi.sidebarWidth);
        }
        if (typeof mergedUi.workspaceWidth === 'number' && mergedUi.workspaceWidth >= 300) {
          setWorkspaceWidth(mergedUi.workspaceWidth);
        }
        if (
          typeof mergedUi.workspaceTreeWidth === 'number' &&
          Number.isFinite(mergedUi.workspaceTreeWidth)
        ) {
          setWorkspaceTreeWidth(Math.max(120, Math.min(600, mergedUi.workspaceTreeWidth)));
        }

        setProfilesLoaded(true);

        if (mergedUi.autoConnect && targetProfile) {
          api.connect(targetProfile).catch(() => {});
        }
      })
      .catch((error: unknown) => {
        // Leave autosave disabled so a damaged settings file is not overwritten.
        setProfilesLoaded(false);
        setProfileStorageError(
          `Could not load settings: ${error instanceof Error ? error.message : String(error)}`
        );
      });

    return () => {
      unsubStatus();
    };
  }, []);

  // Subscribe to Gateway streaming events
  useEffect(() => {
    const api = window.openclawApi;
    if (!api) return;

    const unsubEvent = api.onGatewayEvent((frame) => {
      const eventName = frame?.event;
      const payload = frame?.payload || {};

      // 1. Execution Approval Requested
      if (eventName === 'exec.approval.requested') {
        const req: ExecApprovalRequest = {
          id: payload.id || payload.requestId || `appr-${Date.now()}`,
          sessionKey: payload.sessionKey,
          agentId: payload.agentId,
          command:
            payload.command ||
            payload.cmd ||
            (Array.isArray(payload.argv) ? payload.argv.join(' ') : JSON.stringify(payload)),
          cwd: payload.cwd,
          reason: payload.reason,
          receivedAt: Date.now(),
        };
        setApprovals((prev) => [req, ...prev.filter((x) => x.id !== req.id)]);
        return;
      }

      if (eventName === 'exec.approval.resolved') {
        const resolvedId = payload.id || payload.requestId;
        if (resolvedId) {
          setApprovals((prev) => prev.filter((x) => x.id !== resolvedId));
        }
        return;
      }

      // Track streaming & unread flags across all sessions
      if (eventName === 'agent' || eventName === 'chat') {
        const currentAgent = uiStateRef.current.selectedAgentId || 'main';
        const rawSessionKey = payload.sessionKey
          ? String(payload.sessionKey)
          : uiStateRef.current.selectedSessionKey || 'main';
        const eventAgentId = sessionAgentId(
          rawSessionKey,
          payload.agentId ? String(payload.agentId) : currentAgent
        );
        const eventGatewayKey = toGatewaySessionKey(eventAgentId, rawSessionKey);
        const isTargetActiveSession =
          eventGatewayKey === activeGatewaySessionKeyRef.current ||
          (eventAgentId === currentAgent &&
            rawSessionKey === uiStateRef.current.selectedSessionKey);

        // Ensure newly active session for current agent appears in sidebar session list
        if (payload.sessionKey && eventAgentId === currentAgent) {
          setSessions((prev) => {
            const exists = prev.some(
              (s) =>
                s.key === rawSessionKey ||
                toGatewaySessionKey(s.agentId || currentAgent, s.key) === eventGatewayKey
            );
            if (exists) return prev;
            return [
              {
                key: eventGatewayKey,
                agentId: eventAgentId,
                label: eventGatewayKey.replace(/^agent:[^:]+:/, ''),
                updatedAt: Date.now(),
              },
              ...prev,
            ];
          });
        }

        if (payload.runId) sessionRunIdsRef.current.set(eventGatewayKey, String(payload.runId));

        if (eventName === 'chat') {
          const state = payload.state;
          const isFinal = Boolean(
            payload.final ||
            state === 'final' ||
            state === 'completed' ||
            state === 'aborted' ||
            state === 'error' ||
            payload.error
          );
          markSessionStreaming(eventGatewayKey, !isFinal);
        } else if (eventName === 'agent') {
          const phase = payload.phase || payload.data?.phase;
          const isEnded =
            phase === 'end' ||
            phase === 'error' ||
            payload.state === 'final' ||
            payload.state === 'completed' ||
            payload.state === 'aborted' ||
            payload.state === 'error';
          markSessionStreaming(eventGatewayKey, !isEnded);
          if (isEnded && isTargetActiveSession) {
            setMessages((prev) =>
              prev.map((msg) => (msg.streaming ? { ...msg, streaming: false } : msg))
            );
          }
        }

        if (!isTargetActiveSession) {
          markSessionUnread(eventGatewayKey, true);
          return;
        }

        // If the event is for the currently selected session, still flag as unread if
        // the user is scrolled up in the transcript or the app window is not focused
        const el = messagesContainerRef.current;
        const isScrolledUp = el ? el.scrollHeight - el.scrollTop - el.clientHeight > 150 : false;
        if (isScrolledUp || (typeof document !== 'undefined' && !document.hasFocus())) {
          markSessionUnread(eventGatewayKey, true);
        }
      }

      // 2. Agent Event (thinking deltas, tool calls, lifecycle)
      if (eventName === 'agent') {
        const runId = payload.runId || 'active-run';
        const streamType = payload.stream || payload.type;
        const deltaText = payload.delta || payload.text || payload.data?.delta || '';

        if (streamType === 'thinking' || streamType === 'reasoning' || payload.thinking) {
          const thinkDelta = payload.thinking || deltaText;
          if (!thinkDelta) return;
          setMessages((prev) =>
            upsertStreamingAssistantMessage(prev, runId, (msg) => ({
              ...msg,
              thinking: (msg.thinking || '') + thinkDelta,
            }))
          );
          return;
        }

        if (streamType === 'tool' || payload.toolCall || payload.tool) {
          const tcRaw = payload.toolCall || payload.tool || payload.data || payload;
          const tc: ToolCallItem = {
            id: tcRaw.id || tcRaw.toolCallId || `tc-${Date.now()}`,
            name: tcRaw.name || tcRaw.toolName || 'tool',
            status: tcRaw.status || 'completed',
            args: tcRaw.args || tcRaw.input,
            result: tcRaw.result || tcRaw.output,
          };
          setMessages((prev) =>
            upsertStreamingAssistantMessage(prev, runId, (msg) => {
              const existing = msg.toolCalls || [];
              const idx = existing.findIndex((item) => item.id === tc.id);
              const nextTools =
                idx >= 0
                  ? existing.map((item, i) => (i === idx ? { ...item, ...tc } : item))
                  : [...existing, tc];
              return { ...msg, toolCalls: nextTools };
            })
          );
          return;
        }
      }

      // 3. Chat Event (streaming assistant output & final message)
      if (eventName === 'chat') {
        const runId = payload.runId || 'active-run';
        const state = payload.state;
        const isFinal = Boolean(
          payload.final ||
          state === 'final' ||
          state === 'completed' ||
          state === 'aborted' ||
          state === 'error'
        );
        const fullTextFromMessage = payload.message
          ? extractMessageText(payload.message.content ?? payload.message.text)
          : '';
        const incomingAtts = payload.message ? extractMessageAttachments(payload.message) : [];
        const deltaText = typeof payload.delta === 'string' ? payload.delta : '';

        if (state === 'error' || payload.error) {
          const errText = payload.error?.message || payload.error || 'Agent run failed';
          setMessages((prev) => [
            ...prev,
            {
              id: `err-${Date.now()}`,
              role: 'system',
              content: `Error: ${errText}`,
              timestamp: Date.now(),
              error: true,
            },
          ]);
          return;
        }

        setMessages((prev) =>
          upsertStreamingAssistantMessage(prev, runId, (msg) => {
            const nextContent = fullTextFromMessage ? fullTextFromMessage : msg.content + deltaText;
            return {
              ...msg,
              content: nextContent,
              ...(incomingAtts.length > 0 ? { attachments: incomingAtts } : {}),
              streaming: !isFinal,
            };
          })
        );
      }
    });

    const handleWindowFocus = () => {
      const el = messagesContainerRef.current;
      const isNearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight <= 150;
      if (isNearBottom && activeGatewaySessionKeyRef.current) {
        markSessionUnread(activeGatewaySessionKeyRef.current, false);
      }
    };
    window.addEventListener('focus', handleWindowFocus);

    return () => {
      unsubEvent();
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, []);

  function upsertStreamingAssistantMessage(
    list: ChatMessage[],
    runId: string,
    updater: (msg: ChatMessage) => ChatMessage
  ): ChatMessage[] {
    const idx = list.findIndex((m) => m.role === 'assistant' && (m.runId === runId || m.streaming));
    if (idx >= 0) {
      const copy = [...list];
      copy[idx] = updater(copy[idx]);
      return copy;
    }
    const created: ChatMessage = updater({
      id: `msg-${runId}-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      streaming: true,
      runId,
    });
    return [...list, created];
  }

  // Bootstrap agents, sessions, history, and workspace files after connecting
  useEffect(() => {
    if (connStatus.state === 'connected') {
      refreshGatewayState();
    }
  }, [connStatus.state]);

  async function fetchSessionsAndSyncSelection(
    currentAgent: string,
    preferredSessionKey: string
  ): Promise<string> {
    const api = window.openclawApi;
    if (!api) return preferredSessionKey;

    let sessRes: any = null;
    try {
      sessRes = await api.request('sessions.list', {
        agentId: currentAgent,
        limit: 100,
        includeDerivedTitles: true,
      });
    } catch {
      try {
        sessRes = await api.request('sessions.list', {
          agentId: currentAgent,
          limit: 100,
        });
      } catch {
        return preferredSessionKey;
      }
    }

    if (Array.isArray(sessRes?.sessions)) {
      const list: SessionInfo[] = normalizeSessions(
        sessRes.sessions.length > 0
          ? sessRes.sessions
          : [{ key: 'main', agentId: currentAgent, label: 'Primary Session' }],
        currentAgent
      );

      const withThinking = list.map((session) => ({
        ...session,
        ...sessionThinkingMetadata(session, sessRes.defaults),
      }));
      setSessions(
        withThinking.map((session) => ({
          ...session,
          // A list refresh may omit labels for locally created sessions.
          label:
            session.label ??
            localSessionLabelsRef.current.get(`${activeProfileIdRef.current}:${session.key}`),
        }))
      );

      const preferredKey = toGatewaySessionKey(currentAgent, preferredSessionKey);
      const resolvedKey =
        list.find((session) => session.key === preferredKey)?.key || list[0]?.key || preferredKey;
      if (resolvedKey !== selectedSessionKey) {
        // History can resolve before React commits the selection (for example with a fast Gateway).
        activeGatewaySessionKeyRef.current = resolvedKey;
        uiStateRef.current = { ...uiStateRef.current, selectedSessionKey: resolvedKey };
        setSelectedSessionKey(resolvedKey);
      }
      return resolvedKey;
    }

    return preferredSessionKey;
  }

  async function handleRefreshSessions() {
    const api = window.openclawApi;
    if (!api || connStatus.state !== 'connected' || refreshingSessions) return;
    setRefreshingSessions(true);
    const minSpin = new Promise((r) => setTimeout(r, 300));
    try {
      let currentAgent = selectedAgentId || 'main';
      try {
        const agentsRes = await api.request('agents.list', {});
        if (Array.isArray(agentsRes?.agents) && agentsRes.agents.length > 0) {
          setAgents(agentsRes.agents);
          if (!agentsRes.agents.some((a: any) => a.id === currentAgent)) {
            currentAgent = agentsRes.defaultId || agentsRes.agents[0].id;
            setSelectedAgentId(currentAgent);
          }
        }
      } catch {
        // Ignore if agents.list is restricted
      }

      const resolvedSessionKey = await fetchSessionsAndSyncSelection(
        currentAgent,
        selectedSessionKey || 'main'
      );
      await loadChatHistory(resolvedSessionKey, currentAgent);
    } finally {
      await minSpin;
      setRefreshingSessions(false);
    }
  }

  async function refreshGatewayState(agentOverride?: string, sessionOverride?: string) {
    const api = window.openclawApi;
    if (!api) return;

    saveCurrentSessionScrollPosition();

    const savedUi = uiStateRef.current;
    let currentAgent = agentOverride || savedUi.selectedAgentId || selectedAgentId || 'main';
    try {
      const agentsRes = await api.request('agents.list', {});
      if (Array.isArray(agentsRes?.agents) && agentsRes.agents.length > 0) {
        setAgents(agentsRes.agents);
        const hasCurrent = agentsRes.agents.some((a: any) => a.id === currentAgent);
        if (!agentOverride && !hasCurrent) {
          currentAgent = agentsRes.defaultId || agentsRes.agents[0].id;
          setSelectedAgentId(currentAgent);
        }
      }
    } catch {
      // Fallback to currentAgent if agents.list is restricted
    }

    const preferredSession =
      sessionOverride || selectedSessionKey || savedUi.selectedSessionKey || 'main';
    const resolvedSessionKey = await fetchSessionsAndSyncSelection(currentAgent, preferredSession);

    const targetDir = typeof savedUi.currentDir === 'string' ? savedUi.currentDir : currentDir;
    const targetFile = savedUi.activeFileName || activeFileName || 'AGENTS.md';

    await loadChatHistory(resolvedSessionKey, currentAgent);
    await loadWorkspaceFilesList(currentAgent, targetDir);
    await loadWorkspaceFile(currentAgent, targetFile);
  }

  async function loadChatHistory(sessionKey: string, agentOverride?: string) {
    const api = window.openclawApi;
    if (!api) return;
    saveCurrentSessionScrollPosition();
    const scrollKey = toGatewaySessionKey(agentOverride || selectedAgentId || 'main', sessionKey);
    const reqSeq = ++chatHistorySeqRef.current;
    try {
      const res = await api.request('chat.history', { sessionKey: scrollKey, limit: 100 });
      if (reqSeq !== chatHistorySeqRef.current || scrollKey !== activeGatewaySessionKeyRef.current)
        return;
      const rawMessages = Array.isArray(res?.messages) ? res.messages : [];
      const mapped: ChatMessage[] = rawMessages
        .map((m: any, idx: number) => {
          const attachments = extractMessageAttachments(m);
          return {
            id: m.id || `hist-${idx}-${Date.now()}`,
            role: (m.role === 'user' || m.role === 'assistant' || m.role === 'system'
              ? m.role
              : 'assistant') as 'user' | 'assistant' | 'system',
            content: extractMessageText(m.content ?? m.text ?? ''),
            thinking: m.thinking || undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
            timestamp: m.timestamp || m.ts || Date.now(),
          };
        })
        .filter(
          (m: ChatMessage) => m.content || m.thinking || (m.attachments && m.attachments.length > 0)
        );
      if (!visitedSessionsRef.current.has(scrollKey)) {
        visitedSessionsRef.current.add(scrollKey);
        pendingScrollActionRef.current = { type: 'bottom', sessionKey: scrollKey };
      } else {
        const savedTop = sessionScrollTopRef.current.get(scrollKey);
        pendingScrollActionRef.current =
          typeof savedTop === 'number'
            ? { type: 'restore', sessionKey: scrollKey, scrollTop: savedTop }
            : { type: 'bottom', sessionKey: scrollKey };
      }
      loadedSessionKeyRef.current = scrollKey;
      setMessages(mapped);
    } catch {
      // Keep current messages if chat.history fails
    }
  }

  async function loadWorkspaceFilesList(agentId: string, dirPath = '') {
    const api = window.openclawApi;
    if (!api) return;

    const cleanDir = dirPath.replace(/^\/+|\/+$/g, '');
    setCurrentDir(cleanDir);

    // 1. Fetch root metadata & file sizes from agents.files.list
    const sizeMap = new Map<string, number>();
    try {
      const filesRes = await api.request('agents.files.list', { agentId });
      if (filesRes?.workspace) {
        setWorkspaceRootPath(String(filesRes.workspace).replace(/\/+$/, ''));
      }
      if (Array.isArray(filesRes?.files)) {
        for (const f of filesRes.files) {
          if (f.name && typeof f.size === 'number') {
            sizeMap.set(f.name, f.size);
          }
        }
      }
    } catch {
      // Ignore
    }

    // 2. Fetch full directory tree entries using agents.workspace.list
    try {
      const wsParams: Record<string, any> = { agentId };
      if (cleanDir) wsParams.path = cleanDir;
      const wsRes = await api.request('agents.workspace.list', wsParams);
      if (Array.isArray(wsRes?.entries)) {
        const mapped: WorkspaceFileEntry[] = wsRes.entries.map((e: any) => ({
          name: e.name || e.path.split('/').pop() || e.path,
          path: e.path || e.name,
          kind: e.kind === 'directory' ? 'directory' : 'file',
          size: typeof e.size === 'number' ? e.size : sizeMap.get(e.path || e.name),
          updatedAt: e.updatedAtMs || e.updatedAt,
          missing: false,
        }));

        // Sort directories first, then files alphabetically
        mapped.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

        setWorkspaceFiles(mapped);
        return;
      }
    } catch {
      // Fallback if agents.workspace.list is not supported
    }

    // 3. Fallback to agents.files.list
    try {
      const res = await api.request('agents.files.list', { agentId });
      const list: WorkspaceFileEntry[] = Array.isArray(res?.files)
        ? res.files.map((f: any) => ({
            name: f.name || f.path,
            path: f.name || f.path,
            kind: 'file',
            size: f.size,
            updatedAt: f.updatedAtMs || f.updatedAt,
            missing: f.missing,
          }))
        : [];
      setWorkspaceFiles(list);
    } catch {
      setWorkspaceFiles(
        STANDARD_WORKSPACE_FILES.map((name) => ({ name, path: name, kind: 'file' }))
      );
    }
  }

  async function loadWorkspaceFile(agentId: string, relativePath: string) {
    const api = window.openclawApi;
    if (!api || !relativePath) return;
    const reqSeq = ++workspaceFileSeqRef.current;
    setLoadingFile(true);
    setFileStatusMsg('');

    const cleanRelPath = relativePath.replace(/^\/+/, '');

    // 1. Try agents.workspace.get({ agentId, path }) — supports all files & subfolders in workspace
    try {
      const res = await api.request('agents.workspace.get', {
        agentId,
        path: cleanRelPath,
      });
      if (reqSeq !== workspaceFileSeqRef.current) return;
      const text = res?.file?.content ?? res?.content ?? '';
      const bytes = res?.file?.size ?? new Blob([text]).size;
      setActiveFileName(cleanRelPath);
      setFileContent(text);
      setSavedFileContent(text);
      setFileStatusMsg(`${cleanRelPath} • ${(bytes / 1024).toFixed(1)} KB`);
      setLoadingFile(false);
      return;
    } catch {
      if (reqSeq !== workspaceFileSeqRef.current) return;
      // Fall through to agents.files.get
    }

    // 2. Fallback to agents.files.get({ agentId, name }) — strict schema: ONLY agentId + name
    try {
      const res = await api.request('agents.files.get', {
        agentId,
        name: cleanRelPath,
      });
      if (reqSeq !== workspaceFileSeqRef.current) return;
      const text = res?.file?.content ?? res?.content ?? '';
      const bytes = res?.file?.size ?? new Blob([text]).size;
      setActiveFileName(cleanRelPath);
      setFileContent(text);
      setSavedFileContent(text);
      setFileStatusMsg(`${cleanRelPath} • ${(bytes / 1024).toFixed(1)} KB`);
      setLoadingFile(false);
      return;
    } catch (err: any) {
      if (reqSeq !== workspaceFileSeqRef.current) return;
      setActiveFileName(cleanRelPath);
      setFileContent('');
      setSavedFileContent('');
      setFileStatusMsg(
        `Could not load ${cleanRelPath}: ${err?.message || 'File does not exist yet'}`
      );
      setLoadingFile(false);
    }
  }

  function selectWorkspaceFile(agentId: string, relativePath: string) {
    const cleanRelPath = relativePath.replace(/^\/+/, '');
    if (cleanRelPath === activeFileName) return;
    if (
      fileContent !== savedFileContent &&
      !window.confirm(`Discard unsaved changes to "${activeFileName}"?`)
    ) {
      return;
    }
    loadWorkspaceFile(agentId, cleanRelPath);
  }

  async function handleSaveWorkspaceFile() {
    const api = window.openclawApi;
    if (!api || !activeFileName) return;
    setSavingFile(true);
    setFileStatusMsg('');

    const cleanRelPath = activeFileName.replace(/^\/+/, '');
    const isRootFile = !cleanRelPath.includes('/');

    try {
      let saved = false;
      // 1. If root agent file, try agents.files.set({ agentId, name, content }) first
      if (isRootFile) {
        try {
          await api.request('agents.files.set', {
            agentId: selectedAgentId,
            name: cleanRelPath,
            content: fileContent,
          });
          saved = true;
        } catch {
          // Fall through to sessions.files.set for arbitrary root files
        }
      }

      // 2. Otherwise use sessions.files.set({ sessionKey, path: fullWorkspacePath, content })
      if (!saved) {
        const fullTarget = cleanRelPath.startsWith('/')
          ? cleanRelPath
          : `${workspaceRootPath}/${cleanRelPath}`;
        await api.request('sessions.files.set', {
          sessionKey: toGatewaySessionKey(selectedAgentId, selectedSessionKey),
          path: fullTarget,
          content: fileContent,
        });
      }

      setSavedFileContent(fileContent);
      setFileStatusMsg(
        `✓ Saved ${cleanRelPath} (${(new Blob([fileContent]).size / 1024).toFixed(1)} KB)`
      );
      await loadWorkspaceFilesList(selectedAgentId, currentDir);
    } catch (err: any) {
      setFileStatusMsg(`Failed to save: ${err?.message || 'Unknown error'}`);
    } finally {
      setSavingFile(false);
    }
  }

  function handleCreateNewWorkspaceFile() {
    const raw = newFileNameInput.trim().replace(/^\/+/, '');
    if (!raw) return;
    const relPath = currentDir && !raw.includes('/') ? `${currentDir}/${raw}` : raw;
    if (
      fileContent !== savedFileContent &&
      !window.confirm(`Discard unsaved changes to "${activeFileName}"?`)
    ) {
      return;
    }
    setActiveFileName(relPath);
    setFileContent(`# ${raw}\n\n`);
    setSavedFileContent('');
    setFileStatusMsg(`New file: ${relPath} (press Save or Ctrl+S to write to Gateway)`);
    setNewFileNameInput('');
    setShowNewFileInput(false);
  }

  async function handleConnect(profileToUse?: GatewayProfile) {
    const api = window.openclawApi;
    const target = profileToUse || activeProfile;
    if (!api || !target) return;
    setAutoConnect(true);
    await api.connect(target);
  }

  async function handleDisconnect() {
    setAutoConnect(false);
    const nextUiState: UiSessionState = {
      ...uiStateRef.current,
      autoConnect: false,
    };
    uiStateRef.current = nextUiState;
    try {
      localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(nextUiState));
    } catch {
      // Ignore
    }
    if (profilesLoaded && profiles.length > 0) {
      window.openclawApi
        ?.saveProfiles(profiles, activeProfileId, nextUiState)
        .then(() => setProfileStorageError(''))
        .catch((error: unknown) =>
          setProfileStorageError(
            `Could not save settings: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    }
    await window.openclawApi?.disconnect();
    sessionRunIdsRef.current.clear();
    for (const timer of streamingTimeoutsRef.current.values()) {
      clearTimeout(timer);
    }
    streamingTimeoutsRef.current.clear();
    setStreamingSessionKeys(new Set());
  }

  async function handleAddFiles(fileList: FileList | File[], origin: 'paste' | 'file') {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const added: ChatAttachmentItem[] = [];
    const errors: string[] = [];

    for (const file of files) {
      try {
        const item = await readFileAsAttachment(file, origin);
        added.push(item);
      } catch (err: any) {
        errors.push(err?.message || `Failed to read ${file.name || 'attachment'}`);
      }
    }

    if (added.length > 0) {
      setPendingAttachments((prev) => [...prev, ...added]);
    }
    if (errors.length > 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: `att-err-${Date.now()}`,
          role: 'system',
          content: errors.join('\n'),
          timestamp: Date.now(),
          error: true,
        },
      ]);
    }
  }

  function handleRemoveAttachment(attId: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== attId));
  }

  async function handleSendMessage() {
    const text = composerText.trim();
    const atts = pendingAttachments;
    if (
      (text.length === 0 && atts.length === 0) ||
      connStatus.state !== 'connected' ||
      isChangingModel ||
      isStreaming
    )
      return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      attachments: atts.length > 0 ? atts : undefined,
      timestamp: Date.now(),
    };
    const activeGatewayKey = toGatewaySessionKey(selectedAgentId, selectedSessionKey);
    markSessionUnread(activeGatewayKey, false);
    markSessionStreaming(activeGatewayKey, true);
    setMessages((prev) => [...prev, userMsg]);
    setComposerText('');
    setPendingAttachments([]);

    try {
      const rpcAttachments =
        atts.length > 0
          ? atts.map((a) => ({
              type: a.isImage ? 'image' : 'file',
              mimeType: a.mimeType,
              fileName: a.fileName,
              origin: a.origin,
              content: a.base64 || '',
              sizeBytes: a.sizeBytes,
              ...(typeof a.width === 'number' ? { width: a.width } : {}),
              ...(typeof a.height === 'number' ? { height: a.height } : {}),
            }))
          : undefined;

      const res = await window.openclawApi?.request(
        'chat.send',
        {
          sessionKey: activeGatewayKey,
          agentId: selectedAgentId,
          message: text,
          ...(rpcAttachments ? { attachments: rpcAttachments } : {}),
          idempotencyKey: `idem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        },
        45000
      );
      if (res?.runId && streamingTimeoutsRef.current.has(activeGatewayKey)) {
        sessionRunIdsRef.current.set(activeGatewayKey, res.runId);
      }
    } catch (err: any) {
      markSessionStreaming(activeGatewayKey, false);
      if (activeGatewaySessionKeyRef.current !== activeGatewayKey) return;
      setMessages((prev) => [
        ...prev,
        {
          id: `send-err-${Date.now()}`,
          role: 'system',
          content: `Failed to send message: ${err?.message || 'RPC error'}`,
          timestamp: Date.now(),
          error: true,
        },
      ]);
    }
  }

  async function handleAbortRun() {
    const activeGatewayKey = toGatewaySessionKey(selectedAgentId, selectedSessionKey);
    try {
      await window.openclawApi?.request('chat.abort', {
        sessionKey: activeGatewayKey,
        runId: sessionRunIdsRef.current.get(activeGatewayKey) || undefined,
      });
    } catch {
      // Ignore
    } finally {
      markSessionStreaming(activeGatewayKey, false);
    }
  }

  // Close session context popup on outside click or Escape
  useEffect(() => {
    if (!sessionMenu) return;
    const handlePointerDown = () => {
      setSessionMenu(null);
      setRenamingSessionKey(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSessionMenu(null);
        setRenamingSessionKey(null);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [sessionMenu]);

  // Dismiss Settings or Lightbox on Escape
  useEffect(() => {
    if (!showProfileModal && !lightboxImage) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isRecordingHotkey) {
          e.preventDefault();
          e.stopPropagation();
          setIsRecordingHotkey(false);
          return;
        }
        if (lightboxImage) {
          setLightboxImage(null);
        } else {
          setShowProfileModal(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showProfileModal, lightboxImage, isRecordingHotkey]);

  async function applyGlobalHotkey(nextHotkey: string) {
    const cleaned = nextHotkey.trim();
    setIsRecordingHotkey(false);
    const api = window.openclawApi;
    if (api?.setGlobalHotkey) {
      try {
        const res = await api.setGlobalHotkey(cleaned);
        const normalized = typeof res?.hotkey === 'string' ? res.hotkey : cleaned;
        setGlobalHotkey(normalized);
        setHotkeyStatusMsg({
          text: normalized ? `Saved global shortcut: ${normalized}` : 'Global shortcut disabled.',
        });
      } catch (err: any) {
        setHotkeyStatusMsg({
          text: err?.message || String(err) || 'Failed to register global shortcut.',
          error: true,
        });
      }
    } else {
      setGlobalHotkey(cleaned);
      setHotkeyStatusMsg({
        text: cleaned ? `Saved global shortcut: ${cleaned}` : 'Global shortcut disabled.',
      });
    }
  }

  function formatKeyboardEventToHotkey(e: React.KeyboardEvent): string | null {
    const code = e.code || '';
    const key = e.key || '';
    if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta' || key === 'OS') {
      return null;
    }

    let primary = '';
    if (/^Key([A-Z])$/.test(code)) {
      primary = code.slice(3);
    } else if (/^Digit([0-9])$/.test(code)) {
      primary = code.slice(5);
    } else if (/^Numpad([0-9])$/.test(code)) {
      primary = code.slice(6);
    } else if (/^F([1-9]|1[0-2])$/.test(code)) {
      primary = code;
    } else {
      const codeMap: Record<string, string> = {
        Space: 'Space',
        Tab: 'Tab',
        Enter: 'Enter',
        NumpadEnter: 'Enter',
        Backspace: 'Backspace',
        Delete: 'Delete',
        Insert: 'Insert',
        Home: 'Home',
        End: 'End',
        PageUp: 'PageUp',
        PageDown: 'PageDown',
        ArrowUp: 'Up',
        ArrowDown: 'Down',
        ArrowLeft: 'Left',
        ArrowRight: 'Right',
        Backquote: '`',
        Minus: '-',
        Equal: '=',
        BracketLeft: '[',
        BracketRight: ']',
        Backslash: '\\',
        Semicolon: ';',
        Quote: "'",
        Comma: ',',
        Period: '.',
        Slash: '/',
      };
      if (codeMap[code]) {
        primary = codeMap[code];
      } else if (key.length === 1 && /[a-zA-Z0-9]/.test(key)) {
        primary = key.toUpperCase();
      }
    }

    if (!primary) return null;

    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Win');

    const isFuncKey = /^F([1-9]|1[0-2])$/.test(primary);
    if (parts.length === 0 && !isFuncKey) {
      setHotkeyStatusMsg({
        text: 'Please include at least one modifier key (Ctrl, Alt, Shift, or Win).',
        error: true,
      });
      return null;
    }

    parts.push(primary);
    return parts.join('+');
  }

  // In-window shortcuts: session navigation, Settings, and quit confirmation.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isRecordingHotkey) return;
      if (
        e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.metaKey &&
        (e.key === 'PageUp' || e.key === 'PageDown')
      ) {
        if (
          e.defaultPrevented ||
          e.isComposing ||
          showProfileModal ||
          showQuitConfirmModal ||
          lightboxImage ||
          renamingSessionKey
        )
          return;
        if (sessions.length === 0) return;
        e.preventDefault();
        const current = sessions.findIndex((session) => session.key === selectedSessionKey);
        const offset = e.key === 'PageDown' ? 1 : -1;
        const next =
          current < 0
            ? offset > 0
              ? 0
              : sessions.length - 1
            : (current + offset + sessions.length) % sessions.length;
        const target = sessions[next].key;
        if (target !== selectedSessionKey) {
          setSessionMenu(null);
          handleSelectSession(target);
          composerInputRef.current?.focus();
        }
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        (e.key === ',' || e.code === 'Comma')
      ) {
        e.preventDefault();
        setShowProfileModal(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        if (e.repeat) return;
        if (showQuitConfirmModal) {
          window.openclawApi?.quitApp?.();
        } else {
          setShowQuitConfirmModal(true);
        }
        return;
      }
      if (!showQuitConfirmModal) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowQuitConfirmModal(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    showQuitConfirmModal,
    isRecordingHotkey,
    showProfileModal,
    lightboxImage,
    renamingSessionKey,
    sessions,
    selectedSessionKey,
    selectedAgentId,
    connStatus.state,
  ]);

  // Drag resize handlers for left sidebar and right workspace panel
  useEffect(() => {
    if (!resizingPane) return;
    const handleMouseMove = (e: MouseEvent) => {
      if (resizingPane === 'sidebar') {
        const nextWidth = Math.max(180, Math.min(560, e.clientX));
        setSidebarWidth(nextWidth);
      } else if (resizingPane === 'workspace') {
        const nextWidth = Math.max(300, Math.min(1000, window.innerWidth - e.clientX));
        setWorkspaceWidth(nextWidth);
      } else if (resizingPane === 'workspace-tree' && workspaceSplitRef.current) {
        const bounds = workspaceSplitRef.current.getBoundingClientRect();
        setWorkspaceTreeWidth(
          Math.max(120, Math.min(600, bounds.width - 165, e.clientX - bounds.left))
        );
      }
    };
    const handleMouseUp = () => {
      setResizingPane(null);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('blur', handleMouseUp);
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('blur', handleMouseUp);
    };
  }, [resizingPane]);

  function openSessionMenu(session: SessionInfo, clientX: number, clientY: number) {
    const menuWidth = 288;
    const menuHeight = 320;
    const clampedX = Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8));
    const clampedY = Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8));
    setRenamingSessionKey(null);
    setRenameSessionInput(
      (typeof session.label === 'string' && session.label) || getSessionDisplayName(session)
    );
    setSessionMenu({ sessionKey: session.key, session, x: clampedX, y: clampedY });
  }

  async function handleResetSession(targetKeyOverride?: string) {
    const targetKey = targetKeyOverride || selectedSessionKey;
    const gatewayKey = toGatewaySessionKey(selectedAgentId, targetKey);
    setSessionMenu(null);
    if (connStatus.state !== 'connected') return;
    try {
      await window.openclawApi?.request('sessions.reset', {
        key: gatewayKey,
      });
      if (targetKey === selectedSessionKey) {
        visitedSessionsRef.current.add(gatewayKey);
        sessionScrollTopRef.current.set(gatewayKey, 0);
        loadedSessionKeyRef.current = gatewayKey;
        pendingScrollActionRef.current = { type: 'bottom', sessionKey: gatewayKey };
        setMessages([
          {
            id: `sys-reset-${Date.now()}`,
            role: 'system',
            content: `Session "${targetKey}" was reset.`,
            timestamp: Date.now(),
          },
        ]);
      }
      await fetchSessionsAndSyncSelection(selectedAgentId || 'main', targetKey);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (targetKey === selectedSessionKey) {
        setMessages((prev) => [
          ...prev,
          {
            id: `sys-err-${Date.now()}`,
            role: 'system',
            content: `Could not reset session: ${errMsg}`,
            timestamp: Date.now(),
            error: true,
          },
        ]);
      }
    }
  }

  async function handleDeleteSession(targetKey: string) {
    const gatewayKey = toGatewaySessionKey(selectedAgentId, targetKey);
    setSessionMenu(null);
    if (connStatus.state === 'connected' && window.openclawApi) {
      try {
        await window.openclawApi.request('sessions.delete', {
          key: gatewayKey,
          deleteTranscript: true,
        });
      } catch (err: any) {
        try {
          await window.openclawApi.request('sessions.delete', { key: gatewayKey });
        } catch (err2: any) {
          const msg = err2?.message || err?.message || 'Could not delete session';
          alert(`Could not delete session "${targetKey}": ${msg}`);
          return;
        }
      }
    }

    visitedSessionsRef.current.delete(gatewayKey);
    sessionScrollTopRef.current.delete(gatewayKey);
    markSessionUnread(gatewayKey, false);
    markSessionStreaming(gatewayKey, false);

    const remaining = sessions.filter(
      (s) => toGatewaySessionKey(s.agentId || selectedAgentId, s.key) !== gatewayKey
    );
    const nextSessions: SessionInfo[] =
      remaining.length > 0
        ? remaining
        : [
            {
              key: toGatewaySessionKey(selectedAgentId, 'main'),
              agentId: selectedAgentId,
              label: 'Primary Session',
            },
          ];
    setSessions(nextSessions);

    if (selectedSessionKey === targetKey || selectedSessionKey === gatewayKey) {
      const nextKey = nextSessions[0].key;
      setSelectedSessionKey(nextKey);
      if (connStatus.state === 'connected') {
        loadChatHistory(nextKey);
      } else {
        setMessages([]);
      }
    }
  }

  async function handleRenameSession(targetKey: string, newLabel: string) {
    const trimmed = newLabel.trim();
    const gatewayKey = toGatewaySessionKey(selectedAgentId, targetKey);
    localSessionLabelsRef.current.set(`${activeProfileId}:${gatewayKey}`, trimmed);
    setSessions((prev) =>
      prev.map((s) =>
        s.key === targetKey || s.key === gatewayKey ? { ...s, label: trimmed || null } : s
      )
    );
    setRenamingSessionKey(null);
    if (connStatus.state === 'connected' && window.openclawApi) {
      try {
        await window.openclawApi.request('sessions.patch', {
          key: gatewayKey,
          label: trimmed || null,
        });
      } catch {
        // Ignore if gateway does not support sessions.patch
      }
    }
  }

  async function handleResolveApproval(
    approvalId: string,
    decision: 'allow-once' | 'allow-always' | 'deny'
  ) {
    try {
      await window.openclawApi?.request('exec.approval.resolve', {
        id: approvalId,
        decision,
      });
      setApprovals((prev) => prev.filter((a) => a.id !== approvalId));
    } catch (err: any) {
      alert(`Failed to resolve approval: ${err?.message}`);
    }
  }

  function handleSelectSession(key: string) {
    const gatewayKey = toGatewaySessionKey(selectedAgentId, key);
    saveCurrentSessionScrollPosition();
    markSessionUnread(gatewayKey, false);
    activeGatewaySessionKeyRef.current = gatewayKey;
    uiStateRef.current = { ...uiStateRef.current, selectedSessionKey: gatewayKey };
    setSelectedSessionKey(gatewayKey);
    if (connStatus.state === 'connected') loadChatHistory(gatewayKey);
  }

  async function handleCreateSession() {
    const cleaned = newSessionKeyInput.trim();
    if (!cleaned) return;
    const gatewayKey = toGatewaySessionKey(selectedAgentId, cleaned);
    const label = cleaned.replace(/^agent:[^:]+:/i, '');
    const existing = sessions.find(
      (session) =>
        toGatewaySessionKey(session.agentId || selectedAgentId, session.key) === gatewayKey
    );
    setNewSessionKeyInput('');
    setShowNewSessionInput(false);
    if (existing) {
      handleSelectSession(existing.key);
      return;
    }
    localSessionLabelsRef.current.set(`${activeProfileId}:${gatewayKey}`, label);
    saveCurrentSessionScrollPosition();
    setSessions((prev) =>
      normalizeSessions(
        [
          {
            key: gatewayKey,
            agentId: selectedAgentId,
            label,
            updatedAt: Date.now(),
          },
          ...prev,
        ],
        selectedAgentId
      )
    );
    visitedSessionsRef.current.add(gatewayKey);
    sessionScrollTopRef.current.set(gatewayKey, 0);
    loadedSessionKeyRef.current = gatewayKey;
    pendingScrollActionRef.current = { type: 'bottom', sessionKey: gatewayKey };
    ++chatHistorySeqRef.current;
    activeGatewaySessionKeyRef.current = gatewayKey;
    uiStateRef.current = { ...uiStateRef.current, selectedSessionKey: gatewayKey };
    setSelectedSessionKey(gatewayKey);
    setMessages([]);
    if (connStatus.state === 'connected' && window.openclawApi) {
      try {
        const result = await window.openclawApi.request('sessions.patch', {
          key: gatewayKey,
          label,
        });
        if (result?.ok === false) {
          throw new Error(result.error?.message || 'The Gateway rejected the session name.');
        }
      } catch (error: any) {
        alert(
          `The session is available locally, but its name could not be saved to OpenClaw: ${error?.message || 'RPC error'}. Use Rename to retry.`
        );
      }
    }
  }

  function updateActiveProfileField<K extends keyof GatewayProfile>(
    field: K,
    value: GatewayProfile[K]
  ) {
    const next = profiles.map((p) => (p.id === activeProfileId ? { ...p, [field]: value } : p));
    setProfiles(next);
  }

  function handleAddProfile() {
    const id = `gw-${Date.now()}`;
    const created: GatewayProfile = {
      id,
      name: 'Remote Gateway (HTTPS / WSS)',
      endpoint: 'https://your-gateway-host.example.com',
      token: '',
      clientId: 'gateway-client',
      clientMode: 'ui',
      role: 'operator',
      allowInsecureTls: false,
      includeDeviceIdentity: true,
    };
    const next = [...profiles, created];
    setProfiles(next);
    setActiveProfileId(id);
  }

  function handleDeleteProfile(id: string) {
    if (profiles.length <= 1) return;
    const next = profiles.filter((p) => p.id !== id);
    const nextActive = next[0].id;
    setProfiles(next);
    setActiveProfileId(nextActive);
  }

  const isFileDirty = fileContent !== savedFileContent;
  const fileSizeBytes = new Blob([fileContent]).size;

  return (
    <div
      className="app-shell"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && showWorkspacePane) {
          e.preventDefault();
          handleSaveWorkspaceFile();
        }
      }}
    >
      {/* Top Navigation & Connection Bar */}
      <header className="topbar">
        <div className="brand">
          <img src={YAOC_ICON_URL} width={24} height={24} alt="" aria-hidden="true" />
          <span>YAOC</span>
        </div>

        <div className="connection-bar">
          <select
            className="select-field"
            aria-label="Active Gateway profile"
            style={{ width: '260px' }}
            value={activeProfileId}
            onChange={(e) => {
              const nextId = e.target.value;
              setActiveProfileId(nextId);
            }}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.endpoint})
              </option>
            ))}
          </select>

          <button
            className={`btn ${showWorkspacePane ? 'btn-primary' : ''}`}
            onClick={() => setShowWorkspacePane((v) => !v)}
            title="Toggle Agent Workspace Files Editor"
          >
            <FolderOpen size={14} /> Workspace Files
          </button>

          <button
            type="button"
            className="btn settings-trigger"
            aria-label="Settings"
            title="Settings (Ctrl+,)"
            onClick={() => {
              setSettingsTab('general');
              setShowProfileModal(true);
            }}
          >
            <Settings size={17} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="status-pill"
            onClick={() => {
              if (
                connStatus.state === 'connected' ||
                connStatus.state === 'connecting' ||
                connStatus.state === 'pairing'
              ) {
                handleDisconnect();
              } else {
                handleConnect();
              }
            }}
            title={
              connStatus.state === 'connected'
                ? `Connected to ${connStatus.endpoint || activeProfile?.endpoint || ''} — Click to disconnect`
                : connStatus.state === 'connecting' || connStatus.state === 'pairing'
                  ? `${connStatus.message || 'Connecting...'} — Click to cancel`
                  : `Disconnected — Click to connect to ${activeProfile?.name || 'Gateway'}`
            }
          >
            <span className={`status-dot ${connStatus.state}`} />
            <span style={{ textTransform: 'capitalize' }}>{connStatus.state}</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {profileStorageError && (
        <div className="storage-error" role="alert">
          {profileStorageError}
        </div>
      )}
      <div className="main-body">
        {/* Left Sidebar: Agent & Session Switcher */}
        <aside className="sidebar" style={{ width: `${sidebarWidth}px` }}>
          <div className="sidebar-section">
            <div className="section-label">
              <span>Active Agent</span>
              <Bot size={13} />
            </div>
            <select
              className="select-field"
              value={selectedAgentId}
              onChange={(e) => {
                const nextAgent = e.target.value;
                setSelectedAgentId(nextAgent);
                if (connStatus.state === 'connected') {
                  refreshGatewayState(nextAgent, selectedSessionKey);
                }
              }}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ? `${a.name} (${a.id})` : a.id}
                </option>
              ))}
            </select>
          </div>

          <div className="sidebar-section" style={{ borderBottom: 'none', paddingBottom: '4px' }}>
            <div className="section-label">
              <span>Sessions</span>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  className="btn"
                  style={{ padding: '2px 6px', fontSize: '11px' }}
                  onClick={() => setShowNewSessionInput((v) => !v)}
                  title="New Session"
                >
                  <MessageSquarePlus size={12} /> New
                </button>
                <button
                  className="btn"
                  style={{ padding: '2px 6px', fontSize: '11px' }}
                  onClick={handleRefreshSessions}
                  disabled={connStatus.state !== 'connected' || refreshingSessions}
                  title="Refresh Sessions from Gateway"
                >
                  <RefreshCw size={12} className={refreshingSessions ? 'spin-icon' : ''} />
                </button>
              </div>
            </div>

            {showNewSessionInput && (
              <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                <input
                  className="input-field"
                  placeholder="Session key (e.g. feature-x)"
                  value={newSessionKeyInput}
                  onChange={(e) => setNewSessionKeyInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleCreateSession()}
                />
                <button className="btn btn-primary" onClick={handleCreateSession}>
                  Add
                </button>
              </div>
            )}
          </div>

          <div className="session-list" ref={sessionListRef}>
            {sessions.map((s) => {
              const displayName = getSessionDisplayName(s);
              const isMenuOpen = sessionMenu?.sessionKey === s.key;
              const sessionGatewayKey = toGatewaySessionKey(s.agentId || selectedAgentId, s.key);
              const isSessionStreaming = streamingSessionKeys.has(sessionGatewayKey);
              const hasUnread = unreadSessionKeys.has(sessionGatewayKey);
              return (
                <div
                  key={s.key}
                  className={`session-item ${s.key === selectedSessionKey ? 'active' : ''} ${
                    hasUnread ? 'unread' : ''
                  }`}
                  onClick={() => handleSelectSession(s.key)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openSessionMenu(s, e.clientX, e.clientY);
                  }}
                  title={
                    isSessionStreaming
                      ? `${displayName} (Streaming response...)`
                      : hasUnread
                        ? `${displayName} (New unread message)`
                        : displayName
                  }
                >
                  <span className="session-status-slot" aria-hidden="true">
                    {isSessionStreaming ? (
                      <span className="session-status-spinner" title="Message is streaming in..." />
                    ) : hasUnread ? (
                      <span className="session-status-dot" title="New message arrived" />
                    ) : null}
                  </span>
                  <div className="session-key">{displayName}</div>
                  <button
                    type="button"
                    className={`session-more-btn ${isMenuOpen ? 'open' : ''}`}
                    title="Session details & actions (or right-click)"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (isMenuOpen) {
                        setSessionMenu(null);
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect();
                        openSessionMenu(s, rect.right + 4, rect.top);
                      }
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              );
            })}
          </div>

          <div
            className="sidebar-section"
            style={{
              borderTop: '1px solid var(--border-subtle)',
              borderBottom: 'none',
              fontSize: '11.5px',
              color: 'var(--text-muted)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '6px',
                flexWrap: 'wrap',
              }}
              title={`Version: ${__APP_VERSION_LABEL__} • Built: ${__APP_BUILD_TIMESTAMP__}`}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <Cpu size={13} />
                <span>{__APP_VERSION_LABEL__}</span>
              </span>
              <span>{sysInfo ? `${sysInfo.platform}/${sysInfo.arch}` : 'win32'}</span>
            </div>
          </div>
        </aside>

        {/* Left Sidebar Resize Handle */}
        <div
          className={`pane-resizer ${resizingPane === 'sidebar' ? 'dragging' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            setResizingPane('sidebar');
          }}
          title="Drag to resize Sessions panel"
        />

        {/* Center Pane: Chat & Tool Execution Approvals */}
        <main
          className="chat-pane"
          onDragEnter={(e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            e.stopPropagation();
            dragDepthRef.current += 1;
            if (connStatus.state === 'connected') {
              setIsDraggingOverChat(true);
            }
          }}
          onDragOver={(e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = connStatus.state === 'connected' ? 'copy' : 'none';
          }}
          onDragLeave={(e) => {
            if (!e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            e.stopPropagation();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) {
              setIsDraggingOverChat(false);
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dragDepthRef.current = 0;
            setIsDraggingOverChat(false);
            if (connStatus.state !== 'connected') return;
            const droppedFiles = e.dataTransfer?.files;
            if (droppedFiles && droppedFiles.length > 0) {
              handleAddFiles(droppedFiles, 'file');
            }
          }}
        >
          {isDraggingOverChat && (
            <div className="chat-drop-overlay">
              <div className="chat-drop-card">
                <ImageIcon size={28} />
                <div style={{ fontWeight: 600, fontSize: '15px' }}>
                  Drop images or files to attach
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Images up to 6 MB (auto-compressed) • Files up to 20 MB
                </div>
              </div>
            </div>
          )}
          <div className="pane-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <strong>Session:</strong>
              <code
                style={{
                  background: 'var(--bg-elevated)',
                  padding: '2px 8px',
                  borderRadius: '5px',
                  fontSize: '12.5px',
                }}
              >
                {selectedSessionKey}
              </code>
              <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
                (Agent: {selectedAgentId})
              </span>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn"
                onClick={() => loadChatHistory(selectedSessionKey)}
                disabled={connStatus.state !== 'connected'}
                title="Reload messages for this session from the Gateway (chat.history)"
              >
                <RefreshCw size={13} /> Reload Chat
              </button>
              <button
                className="btn"
                onClick={() => handleResetSession()}
                disabled={connStatus.state !== 'connected'}
                title="Reset Session Context"
              >
                <RotateCcw size={13} /> Reset Session
              </button>
            </div>
          </div>

          {/* Pending Tool Execution Approval Prompts */}
          {approvals.length > 0 && (
            <div className="approval-stack">
              {approvals.map((req) => (
                <div key={req.id} className="approval-card">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        fontWeight: 600,
                        color: 'var(--text-warning)',
                      }}
                    >
                      <ShieldAlert size={16} />
                      <span>Tool Execution Approval Requested</span>
                      {req.agentId && (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          ({req.agentId})
                        </span>
                      )}
                    </div>
                    <div className="approval-code">{req.command}</div>
                    {(req.cwd || req.reason) && (
                      <div
                        style={{
                          fontSize: '11.5px',
                          color: 'var(--text-muted)',
                          marginTop: '4px',
                        }}
                      >
                        {req.cwd && <span>CWD: {req.cwd} </span>}
                        {req.reason && <span>• Reason: {req.reason}</span>}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button
                      className="btn btn-success"
                      onClick={() => handleResolveApproval(req.id, 'allow-once')}
                    >
                      <Check size={14} /> Allow Once
                    </button>
                    <button
                      className="btn"
                      onClick={() => handleResolveApproval(req.id, 'allow-always')}
                    >
                      Always Allow
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={() => handleResolveApproval(req.id, 'deny')}
                    >
                      <X size={14} /> Deny
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Chat Transcript or Step-by-Step Pairing / Connection Guide */}
          <div
            className="messages-container"
            ref={messagesContainerRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const loadedKey = loadedSessionKeyRef.current;
              const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              if (loadedKey && !pendingScrollActionRef.current) {
                sessionScrollTopRef.current.set(loadedKey, el.scrollTop);
              }
              if (loadedKey && distFromBottom <= 80) {
                markSessionUnread(loadedKey, false);
              }
              const lock = initialBottomLockUntilRef.current;
              if (lock && distFromBottom > 60) {
                initialBottomLockUntilRef.current = null;
              }
            }}
          >
            {connStatus.state === 'pairing' ? (
              <div className="guide-card">
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: '12px',
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '8px',
                        color: 'var(--text-info)',
                        fontSize: '12px',
                        fontWeight: 600,
                        marginBottom: '4px',
                      }}
                    >
                      <span className="status-dot pairing" />
                      <span>ONE-TIME DEVICE PAIRING REQUIRED</span>
                    </div>
                    <h3 style={{ fontSize: '17px', color: 'var(--text-main)' }}>
                      Approve this Windows client on {activeProfile?.endpoint}
                    </h3>
                    <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: '4px' }}>
                      Your Gateway received this client&apos;s cryptographic Ed25519 identity and is
                      waiting for one-time owner approval.
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <button
                      className={`btn ${!useDockerCmds ? 'btn-primary' : ''}`}
                      style={{ padding: '4px 9px', fontSize: '11.5px' }}
                      onClick={() => setUseDockerCmds(false)}
                    >
                      Host CLI
                    </button>
                    <button
                      className={`btn ${useDockerCmds ? 'btn-primary' : ''}`}
                      style={{ padding: '4px 9px', fontSize: '11.5px' }}
                      onClick={() => setUseDockerCmds(true)}
                    >
                      Docker CLI
                    </button>
                  </div>
                </div>

                {/* Step 1 */}
                <div className="guide-step">
                  <div className="guide-step-title">
                    <span>
                      <span className="step-badge">1</span>
                      Approve the pending request on your Gateway server
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 400 }}>
                      Run via SSH / Server Terminal
                    </span>
                  </div>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {connStatus.details?.requestId
                      ? 'Run this command to approve your specific pending request ID:'
                      : 'Approve the latest pending device request directly, or list pending requests first:'}
                  </p>

                  {(() => {
                    const prefix = useDockerCmds
                      ? 'docker compose exec openclaw-gateway openclaw'
                      : 'openclaw';
                    const reqId = connStatus.details?.requestId;
                    const primaryCmd = reqId
                      ? `${prefix} devices approve ${reqId}`
                      : `${prefix} devices approve --latest`;
                    const listCmd = `${prefix} devices list`;

                    return (
                      <>
                        <div className="cmd-row">
                          <code style={{ wordBreak: 'break-all' }}>{primaryCmd}</code>
                          <button
                            className="btn"
                            style={{ padding: '3px 9px', fontSize: '11.5px', flexShrink: 0 }}
                            onClick={() => copyText(primaryCmd, 'primary')}
                          >
                            {copiedCmd === 'primary' ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                        <div
                          style={{
                            fontSize: '11.5px',
                            color: 'var(--text-muted)',
                            marginTop: '2px',
                          }}
                        >
                          Or inspect all pending requests first:
                        </div>
                        <div className="cmd-row">
                          <code>{listCmd}</code>
                          <button
                            className="btn"
                            style={{ padding: '3px 9px', fontSize: '11.5px', flexShrink: 0 }}
                            onClick={() => copyText(listCmd, 'list')}
                          >
                            {copiedCmd === 'list' ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Step 2 */}
                <div className="guide-step">
                  <div className="guide-step-title">
                    <span>
                      <span className="step-badge">2</span>
                      Verify Device ID (or approve via Web Control UI)
                    </span>
                  </div>
                  <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    If you already have the OpenClaw Control UI open in your browser at{' '}
                    <code>{activeProfile?.endpoint}</code>, you can also approve this device under{' '}
                    <strong>Nodes / Devices</strong> by matching this Device ID:
                  </p>
                  <div className="cmd-row">
                    <code
                      style={{
                        fontSize: '11.5px',
                        wordBreak: 'break-all',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {connStatus.deviceId || sysInfo?.deviceIdentity?.deviceId || 'Generating...'}
                    </code>
                    <button
                      className="btn"
                      style={{ padding: '3px 9px', fontSize: '11.5px', flexShrink: 0 }}
                      onClick={() =>
                        copyText(
                          connStatus.deviceId || sysInfo?.deviceIdentity?.deviceId || '',
                          'devid'
                        )
                      }
                    >
                      {copiedCmd === 'devid' ? '✓ Copied' : 'Copy ID'}
                    </button>
                  </div>
                </div>

                {/* Step 3: Optional Token inline input */}
                <div className="guide-step">
                  <div className="guide-step-title">
                    <span>
                      <span className="step-badge">3</span>
                      Gateway Token (Optional — if your Gateway requires token auth)
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      type="password"
                      className="input-field"
                      placeholder="Paste gateway.auth.token if required by your server..."
                      value={activeProfile?.token || ''}
                      onChange={(e) => updateActiveProfileField('token', e.target.value)}
                    />
                  </div>
                </div>

                {/* Footer Actions */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingTop: '4px',
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={autoPollPairing}
                      onChange={(e) => setAutoPollPairing(e.target.checked)}
                    />
                    <span>Automatically check every 5 seconds and connect once approved</span>
                  </label>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-primary" onClick={() => handleConnect()}>
                      <RefreshCw size={13} /> Check Now
                    </button>
                  </div>
                </div>
              </div>
            ) : connStatus.state === 'error' ? (
              <div className="guide-card">
                <div>
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                      color: 'var(--text-danger)',
                      fontSize: '12px',
                      fontWeight: 600,
                      marginBottom: '4px',
                    }}
                  >
                    <span className="status-dot error" />
                    <span>CONNECTION TROUBLESHOOTING</span>
                  </div>
                  <h3 style={{ fontSize: '17px', color: 'var(--text-main)' }}>
                    Could not connect to {activeProfile?.endpoint}
                  </h3>
                  <div
                    className="cmd-row"
                    style={{
                      marginTop: '8px',
                      color: 'var(--text-danger)',
                      borderColor: 'rgba(239,68,68,0.35)',
                    }}
                  >
                    <code>{connStatus.message || 'Connection failed'}</code>
                  </div>
                </div>

                <div className="guide-step">
                  <div className="guide-step-title">
                    <span>
                      <span className="step-badge">1</span>
                      Check Endpoint URL &amp; Gateway Auth Token
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: '8px' }}>
                    <input
                      className="input-field"
                      placeholder="https://gateway.example.com or ws://127.0.0.1:18789"
                      value={activeProfile?.endpoint || ''}
                      onChange={(e) => updateActiveProfileField('endpoint', e.target.value)}
                    />
                    <input
                      type="password"
                      className="input-field"
                      placeholder="Gateway Auth Token (if required)"
                      value={activeProfile?.token || ''}
                      onChange={(e) => updateActiveProfileField('token', e.target.value)}
                    />
                  </div>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      fontSize: '12px',
                      color: 'var(--text-muted)',
                      marginTop: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(activeProfile?.allowInsecureTls)}
                      onChange={(e) =>
                        updateActiveProfileField('allowInsecureTls', e.target.checked)
                      }
                    />
                    <span>Allow self-signed / private TLS certificates</span>
                  </label>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                  <button
                    className="btn"
                    onClick={() => {
                      setSettingsTab('gateway');
                      setShowProfileModal(true);
                    }}
                  >
                    <Settings size={13} /> Gateway Profiles
                  </button>
                  <button className="btn btn-primary" onClick={() => handleConnect()}>
                    <RefreshCw size={13} /> Retry Connection
                  </button>
                </div>
              </div>
            ) : messages.length === 0 ? (
              <div
                style={{
                  margin: 'auto',
                  textAlign: 'center',
                  maxWidth: '460px',
                  color: 'var(--text-muted)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  alignItems: 'center',
                }}
              >
                <img src={YAOC_ICON_URL} width={56} height={56} alt="" aria-hidden="true" />
                <h3 style={{ color: 'var(--text-main)', fontSize: '16px' }}>
                  YAOC — Yet Another OpenClaw Chat
                </h3>
                <p style={{ fontSize: '13px' }}>
                  An independent client for OpenClaw. Connect to your local or remote Gateway
                  (`ws://`, `wss://`, `http://`, or `https://`), or test immediately using the{' '}
                  <strong>Built-in Demo Gateway (Offline Test)</strong> profile.
                </p>
                {connStatus.state !== 'connected' && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                    <button className="btn btn-primary" onClick={() => handleConnect()}>
                      <Plug size={14} /> Connect to {activeProfile?.name}
                    </button>
                    <button
                      className="btn"
                      onClick={() => {
                        const demo = profiles.find((p) => p.endpoint.startsWith('mock://'));
                        if (demo) {
                          setActiveProfileId(demo.id);
                          handleConnect(demo);
                        }
                      }}
                    >
                      <Play size={14} /> Try Offline Demo Mode
                    </button>
                  </div>
                )}
              </div>
            ) : (
              messages.map((m) => {
                const isMarkdownDetected = Boolean(m.content && hasMarkdownSyntax(m.content));
                const showRaw = rawMessageIds.has(m.id);
                return (
                  <div
                    key={m.id}
                    className={`message-card ${m.role}`}
                    role="article"
                    aria-label={
                      m.role === 'user'
                        ? 'You'
                        : m.role === 'assistant'
                          ? `OpenClaw (${selectedAgentId})`
                          : 'System'
                    }
                  >
                    <div className="message-header">
                      {m.role === 'system' && <span className="message-sender">System</span>}
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                        {isMarkdownDetected && (
                          <button
                            type="button"
                            className={`msg-format-toggle ${showRaw ? 'raw-active' : ''}`}
                            onClick={() => toggleRawMessage(m.id)}
                            title={
                              showRaw
                                ? 'Switch to rendered Markdown view'
                                : 'Switch to raw Markdown source'
                            }
                          >
                            {showRaw ? 'Markdown' : 'Raw'}
                          </button>
                        )}
                        <span>
                          {m.streaming
                            ? '● Streaming...'
                            : new Date(m.timestamp).toLocaleTimeString()}
                        </span>
                      </span>
                    </div>

                    {m.thinking && (
                      <details className="thinking-box" open={m.streaming}>
                        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '11.5px' }}>
                          Reasoning / Thinking
                        </summary>
                        <div style={{ marginTop: '6px', whiteSpace: 'pre-wrap' }}>{m.thinking}</div>
                      </details>
                    )}

                    {m.toolCalls && m.toolCalls.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {m.toolCalls.map((tc) => (
                          <div key={tc.id} className="tool-box">
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                fontWeight: 600,
                                color: 'var(--text-success)',
                              }}
                            >
                              <span
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}
                              >
                                <Wrench size={13} /> {tc.name}
                              </span>
                              <span style={{ fontSize: '11px' }}>{tc.status || 'completed'}</span>
                            </div>
                            {tc.args && (
                              <pre
                                style={{
                                  marginTop: '4px',
                                  fontSize: '11px',
                                  color: 'var(--text-muted)',
                                  overflowX: 'auto',
                                }}
                              >
                                {typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args)}
                              </pre>
                            )}
                            {tc.result && (
                              <div
                                style={{
                                  marginTop: '4px',
                                  fontSize: '11.5px',
                                  color: 'var(--text-success)',
                                }}
                              >
                                {typeof tc.result === 'string'
                                  ? tc.result
                                  : JSON.stringify(tc.result)}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {m.attachments && m.attachments.length > 0 && (
                      <div className="message-attachments">
                        {m.attachments.map((att) =>
                          att.isImage && att.previewUrl ? (
                            <button
                              key={att.id}
                              type="button"
                              className="message-image-btn"
                              onClick={() =>
                                setLightboxImage({
                                  url: att.previewUrl!,
                                  fileName: att.fileName,
                                })
                              }
                              title={`Click to view ${att.fileName}`}
                            >
                              <img
                                src={att.previewUrl}
                                alt={att.fileName}
                                className="message-image-thumb"
                                onLoad={() => {
                                  const lock = initialBottomLockUntilRef.current;
                                  const el = messagesContainerRef.current;
                                  if (
                                    lock &&
                                    el &&
                                    lock.sessionKey === loadedSessionKeyRef.current &&
                                    Date.now() < lock.expiresAt
                                  ) {
                                    el.scrollTop = el.scrollHeight;
                                    sessionScrollTopRef.current.set(lock.sessionKey, el.scrollTop);
                                  }
                                }}
                              />
                            </button>
                          ) : (
                            <div key={att.id} className="message-file-badge" title={att.fileName}>
                              <FileText
                                size={14}
                                style={{ flexShrink: 0, color: 'var(--text-muted)' }}
                              />
                              <span className="message-file-name">{att.fileName}</span>
                              {att.sizeBytes > 0 && (
                                <span className="message-file-size">
                                  {formatByteSize(att.sizeBytes)}
                                </span>
                              )}
                            </div>
                          )
                        )}
                      </div>
                    )}

                    {m.content &&
                      (isMarkdownDetected && !showRaw ? (
                        <div className="message-body markdown-rendered">
                          <MarkdownContent content={m.content} />
                        </div>
                      ) : (
                        <div className="message-body">{m.content}</div>
                      ))}
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Message Composer */}
          <div className="composer-wrapper">
            {pendingAttachments.length > 0 && (
              <div className="composer-attachments">
                {pendingAttachments.map((att) => (
                  <div key={att.id} className="attachment-chip" title={att.fileName}>
                    {att.isImage && att.previewUrl ? (
                      <img
                        src={att.previewUrl}
                        alt={att.fileName}
                        className="attachment-chip-thumb"
                        onClick={() =>
                          setLightboxImage({ url: att.previewUrl!, fileName: att.fileName })
                        }
                      />
                    ) : (
                      <div className="attachment-chip-icon">
                        <FileText size={16} />
                      </div>
                    )}
                    <div className="attachment-chip-meta">
                      <span className="attachment-chip-name">{att.fileName}</span>
                      <span className="attachment-chip-size">
                        {formatByteSize(att.sizeBytes)}
                        {att.width && att.height ? ` • ${att.width}×${att.height}` : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="attachment-chip-remove"
                      onClick={() => handleRemoveAttachment(att.id)}
                      title="Remove attachment"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="composer-bar">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleAddFiles(e.target.files, 'file');
                  }
                  e.target.value = '';
                }}
              />
              <textarea
                ref={composerInputRef}
                className="composer-input"
                aria-label="Message Assistant"
                rows={2}
                placeholder={
                  connStatus.state === 'connected'
                    ? 'Message Assistant'
                    : 'Connect to a Gateway to message Assistant'
                }
                value={composerText}
                disabled={connStatus.state !== 'connected'}
                onChange={(e) => setComposerText(e.target.value)}
                onPaste={(e) => {
                  if (connStatus.state !== 'connected') return;
                  const items = e.clipboardData?.items;
                  if (!items) return;
                  const pastedFiles: File[] = [];
                  for (let i = 0; i < items.length; i++) {
                    const item = items[i];
                    if (item.kind === 'file') {
                      const file = item.getAsFile();
                      if (file) pastedFiles.push(file);
                    }
                  }
                  if (pastedFiles.length > 0) {
                    e.preventDefault();
                    handleAddFiles(pastedFiles, 'paste');
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
              />
              <div className="composer-toolbar">
                <button
                  type="button"
                  className="composer-icon-btn composer-attach-btn"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={connStatus.state !== 'connected'}
                  aria-label="Attach images or files"
                  title="Attach images or files (Ctrl+V or drag and drop)"
                >
                  <Plus size={17} strokeWidth={1.6} />
                </button>
                <SessionModelSwitcher
                  connectionId={`${activeProfileId}:${connStatus.endpoint || ''}`}
                  connected={connStatus.state === 'connected'}
                  agentId={selectedAgentId}
                  sessionKey={selectedSessionKey}
                  model={sessions.find((session) => session.key === selectedSessionKey)?.model}
                  modelProvider={
                    sessions.find((session) => session.key === selectedSessionKey)?.modelProvider
                  }
                  thinkingLevel={
                    sessions.find((session) => session.key === selectedSessionKey)?.thinkingLevel
                  }
                  thinkingMetadata={sessions.find((session) => session.key === selectedSessionKey)}
                  streaming={isStreaming}
                  onBusyChange={setIsChangingModel}
                  onThinkingChanged={(thinkingLevel) =>
                    setSessions((previous) =>
                      previous.map((session) =>
                        session.key === selectedSessionKey ? { ...session, thinkingLevel } : session
                      )
                    )
                  }
                  onModelChanged={(selection) =>
                    setSessions((previous) =>
                      previous.map((session) =>
                        session.key === selectedSessionKey ? { ...session, ...selection } : session
                      )
                    )
                  }
                />
                {isStreaming ? (
                  <button
                    type="button"
                    className="composer-icon-btn composer-send-btn composer-stop-btn"
                    aria-label="Stop response"
                    title="Stop response"
                    onClick={handleAbortRun}
                  >
                    <Square size={13} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="composer-icon-btn composer-send-btn"
                    aria-label="Send message"
                    title="Send message (Enter)"
                    onClick={handleSendMessage}
                    disabled={
                      connStatus.state !== 'connected' ||
                      isChangingModel ||
                      (composerText.trim().length === 0 && pendingAttachments.length === 0)
                    }
                  >
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>

        {/* Right Pane: Full Workspace Directory Browser & File Editor */}
        {showWorkspacePane && (
          <>
            <div
              className={`pane-resizer ${resizingPane === 'workspace' ? 'dragging' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                setResizingPane('workspace');
              }}
              title="Drag to resize Workspace panel"
            />
            <section className="workspace-pane" style={{ width: `${workspaceWidth}px` }}>
              <div className="pane-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                  <FileCode2 size={15} color="var(--text-accent)" />
                  <strong style={{ whiteSpace: 'nowrap' }}>Workspace</strong>
                  <code
                    style={{
                      fontSize: '11.5px',
                      color: 'var(--text-accent)',
                      background: 'var(--bg-elevated)',
                      padding: '2px 7px',
                      borderRadius: '5px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={`${workspaceRootPath}/${activeFileName}`}
                  >
                    {activeFileName}
                  </code>
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button
                    className="btn"
                    onClick={() => setShowNewFileInput((v) => !v)}
                    disabled={connStatus.state !== 'connected'}
                    title="Create New File in Current Folder"
                  >
                    <FilePlus2 size={13} />
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      loadWorkspaceFilesList(selectedAgentId, currentDir);
                      loadWorkspaceFile(selectedAgentId, activeFileName);
                    }}
                    disabled={connStatus.state !== 'connected' || loadingFile}
                    title="Reload Workspace Tree & Active File"
                  >
                    <RefreshCw size={13} />
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={handleSaveWorkspaceFile}
                    disabled={connStatus.state !== 'connected' || savingFile || !isFileDirty}
                    title="Save to Workspace (Ctrl+S)"
                  >
                    <Save size={13} /> {savingFile ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>

              {showNewFileInput && (
                <div
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--border-subtle)',
                    background: 'var(--bg-root)',
                    display: 'flex',
                    gap: '6px',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                    {currentDir ? `${currentDir}/` : '/'}
                  </span>
                  <input
                    className="input-field"
                    placeholder="filename.md (Enter to create)"
                    value={newFileNameInput}
                    onChange={(e) => setNewFileNameInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateNewWorkspaceFile()}
                  />
                  <button className="btn btn-primary" onClick={handleCreateNewWorkspaceFile}>
                    Create
                  </button>
                </div>
              )}

              {/* Quick-jump bar for core persona files */}
              <div className="file-tabs">
                <button
                  className={`file-tab ${currentDir === '' ? 'active' : ''}`}
                  onClick={() => loadWorkspaceFilesList(selectedAgentId, '')}
                  title="Go to Workspace Root"
                >
                  <Folder size={12} /> /root
                </button>
                {['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md', 'DREAMS.md', 'IDENTITY.md'].map(
                  (name) => (
                    <button
                      key={name}
                      className={`file-tab ${activeFileName === name ? 'active' : ''}`}
                      onClick={() => selectWorkspaceFile(selectedAgentId, name)}
                    >
                      <span>{name}</span>
                      {activeFileName === name && isFileDirty && (
                        <span style={{ color: 'var(--text-accent)' }}>●</span>
                      )}
                    </button>
                  )
                )}
              </div>

              <div className="workspace-split" ref={workspaceSplitRef}>
                {/* Left Column: Directory & File Explorer Tree */}
                <div className="workspace-tree" style={{ width: `${workspaceTreeWidth}px` }}>
                  <div className="workspace-tree-header">
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontWeight: 600,
                      }}
                      title={currentDir ? `${workspaceRootPath}/${currentDir}` : workspaceRootPath}
                    >
                      /{currentDir}
                    </span>
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        cursor: 'pointer',
                        fontSize: '10.5px',
                        flexShrink: 0,
                      }}
                      title="Show dotfiles (.git, .openclaw)"
                    >
                      <input
                        type="checkbox"
                        checked={showHiddenFiles}
                        onChange={(e) => setShowHiddenFiles(e.target.checked)}
                      />
                      <span>.*</span>
                    </label>
                  </div>

                  <div className="workspace-tree-list">
                    {currentDir && (
                      <button
                        className="tree-item"
                        onClick={() => {
                          const parts = currentDir.split('/');
                          parts.pop();
                          loadWorkspaceFilesList(selectedAgentId, parts.join('/'));
                        }}
                      >
                        <span className="tree-item-name" style={{ color: 'var(--text-muted)' }}>
                          <CornerLeftUp size={13} /> .. (Up)
                        </span>
                      </button>
                    )}

                    {workspaceFiles
                      .filter((f) => showHiddenFiles || !f.name.startsWith('.'))
                      .map((entry) => {
                        const isDir = entry.kind === 'directory';
                        const isSelected = !isDir && entry.path === activeFileName;
                        return (
                          <button
                            key={entry.path}
                            className={`tree-item ${isSelected ? 'active' : ''}`}
                            onClick={() => {
                              if (isDir) {
                                loadWorkspaceFilesList(selectedAgentId, entry.path);
                              } else {
                                selectWorkspaceFile(selectedAgentId, entry.path);
                              }
                            }}
                            title={entry.path}
                          >
                            <span className="tree-item-name">
                              {isDir ? (
                                <Folder
                                  size={13}
                                  color="var(--text-warning)"
                                  style={{ flexShrink: 0 }}
                                />
                              ) : (
                                <FileText
                                  size={13}
                                  color="var(--text-muted)"
                                  style={{ flexShrink: 0 }}
                                />
                              )}
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {entry.name}
                              </span>
                            </span>
                            {!isDir && typeof entry.size === 'number' && (
                              <span className="tree-item-size">
                                {entry.size >= 1024
                                  ? `${(entry.size / 1024).toFixed(1)}K`
                                  : `${entry.size}B`}
                              </span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                </div>

                <div
                  className={`pane-resizer ${resizingPane === 'workspace-tree' ? 'dragging' : ''}`}
                  role="separator"
                  aria-label="Resize workspace file list"
                  aria-orientation="vertical"
                  tabIndex={0}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    setResizingPane('workspace-tree');
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    e.preventDefault();
                    const maxWidth = Math.min(
                      600,
                      (workspaceSplitRef.current?.clientWidth ?? workspaceWidth) - 165
                    );
                    setWorkspaceTreeWidth((width) =>
                      Math.max(120, Math.min(maxWidth, width + (e.key === 'ArrowRight' ? 10 : -10)))
                    );
                  }}
                  title="Drag to resize file list, or use Left/Right arrow keys"
                />

                {/* Right Column: File Content Editor */}
                <div className="workspace-editor-col">
                  <textarea
                    className="editor-textarea"
                    value={fileContent}
                    onChange={(e) => setFileContent(e.target.value)}
                    placeholder={
                      loadingFile
                        ? `Loading ${activeFileName}...`
                        : connStatus.state === 'connected'
                          ? `Editing ${activeFileName}...`
                          : 'Connect to a Gateway to browse and edit workspace files'
                    }
                    disabled={connStatus.state !== 'connected' || loadingFile}
                  />

                  <div
                    style={{
                      padding: '7px 12px',
                      borderTop: '1px solid var(--border-subtle)',
                      fontSize: '11.5px',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {fileStatusMsg ||
                        `${activeFileName} • ${(fileSizeBytes / 1024).toFixed(1)} KB`}
                    </span>
                    <span
                      style={{
                        flexShrink: 0,
                        color: isFileDirty ? 'var(--text-accent)' : undefined,
                      }}
                    >
                      {isFileDirty ? '● Unsaved (Ctrl+S)' : 'Synced'}
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </>
        )}
      </div>

      {/* General settings and Gateway Profiles */}
      {showProfileModal && (
        <div className="modal-backdrop" onClick={() => setShowProfileModal(false)}>
          <div
            className="modal-card settings-dialog"
            ref={settingsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key !== 'Tab') return;
              const controls = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), [tabindex="0"]'
                )
              );
              const first = controls[0];
              const last = controls[controls.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 id="settings-title" style={{ fontSize: '16px' }}>
                Settings
              </h3>
              <button
                className="btn"
                aria-label="Close settings"
                onClick={() => setShowProfileModal(false)}
              >
                <X size={14} />
              </button>
            </div>

            <div className="settings-body">
              <div
                className="settings-tabs"
                role="tablist"
                aria-label="Settings categories"
                aria-orientation="vertical"
              >
                {(['general', 'gateway'] as const).map((tab) => (
                  <button
                    key={tab}
                    id={`settings-tab-${tab}`}
                    role="tab"
                    className={`settings-tab ${settingsTab === tab ? 'active' : ''}`}
                    aria-selected={settingsTab === tab}
                    aria-controls={`settings-panel-${tab}`}
                    tabIndex={settingsTab === tab ? 0 : -1}
                    onClick={() => setSettingsTab(tab)}
                    onKeyDown={(e) => {
                      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
                      e.preventDefault();
                      const next =
                        e.key === 'Home'
                          ? 'general'
                          : e.key === 'End'
                            ? 'gateway'
                            : tab === 'general'
                              ? 'gateway'
                              : 'general';
                      setSettingsTab(next);
                      document.getElementById(`settings-tab-${next}`)?.focus();
                    }}
                  >
                    {tab === 'general' ? 'General' : 'Gateway Profiles'}
                  </button>
                ))}
              </div>

              {settingsTab === 'general' && (
                <div
                  className="settings-panel"
                  id="settings-panel-general"
                  role="tabpanel"
                  aria-labelledby="settings-tab-general"
                >
                  <div className="form-row">
                    <label htmlFor="theme-select">Theme</label>
                    <select
                      id="theme-select"
                      className="select-field"
                      value={theme}
                      onChange={(e) => setTheme(e.target.value as Theme)}
                    >
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                      <option value="system">System</option>
                    </select>
                    <p className="settings-help">
                      System follows your operating system’s appearance. Changes apply immediately.
                    </p>
                  </div>

                  <div className="form-row">
                    <label htmlFor="global-hotkey-recorder">Global Show / Hide Shortcut</label>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <button
                        id="global-hotkey-recorder"
                        type="button"
                        className={`btn ${isRecordingHotkey ? 'btn-primary' : ''}`}
                        style={{
                          flex: 1,
                          justifyContent: 'space-between',
                          padding: '7px 11px',
                          fontFamily: 'var(--font-mono)',
                          fontSize: '12.5px',
                          border: isRecordingHotkey
                            ? '1px solid var(--text-accent)'
                            : '1px solid var(--border-subtle)',
                        }}
                        onClick={() => {
                          setHotkeyStatusMsg(null);
                          setIsRecordingHotkey((prev) => !prev);
                        }}
                        onBlur={() => setIsRecordingHotkey(false)}
                        onKeyDown={(e) => {
                          if (!isRecordingHotkey) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.key === 'Escape') {
                            setIsRecordingHotkey(false);
                            return;
                          }
                          const combo = formatKeyboardEventToHotkey(e);
                          if (combo) {
                            applyGlobalHotkey(combo);
                          }
                        }}
                      >
                        <span>
                          {isRecordingHotkey
                            ? 'Press shortcut keys now (Esc to cancel)...'
                            : globalHotkey || 'Disabled'}
                        </span>
                        <span
                          style={{
                            fontSize: '11px',
                            fontFamily: 'var(--font-sans)',
                            color: isRecordingHotkey ? 'inherit' : 'var(--text-muted)',
                          }}
                        >
                          {isRecordingHotkey ? 'Recording' : 'Click to record'}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => applyGlobalHotkey('Alt+Shift+3')}
                        disabled={globalHotkey === 'Alt+Shift+3' && !isRecordingHotkey}
                        title="Reset to default (Alt+Shift+3)"
                      >
                        Reset
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => applyGlobalHotkey('')}
                        disabled={!globalHotkey && !isRecordingHotkey}
                        title="Disable global shortcut"
                      >
                        Disable
                      </button>
                    </div>
                    {hotkeyStatusMsg && (
                      <p
                        className="settings-help"
                        style={{
                          color: hotkeyStatusMsg.error
                            ? 'var(--text-danger)'
                            : 'var(--text-accent)',
                          marginTop: '2px',
                        }}
                      >
                        {hotkeyStatusMsg.text}
                      </p>
                    )}
                    <p className="settings-help">
                      Toggles the YAOC window from anywhere in Windows. Closing the window hides it
                      to the system tray; press <code>Ctrl+Q</code> in the window or right-click the
                      tray icon to quit completely.
                    </p>
                  </div>

                  <div
                    style={{
                      background: 'var(--bg-root)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '8px',
                      padding: '10px 12px',
                      fontSize: '12px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        marginBottom: '2px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>Build &amp; Version Info</span>
                      <span
                        style={{
                          fontSize: '10.5px',
                          fontWeight: 600,
                          padding: '1px 7px',
                          borderRadius: '999px',
                          background:
                            __APP_CHANNEL__ === 'official'
                              ? 'rgba(34, 197, 94, 0.14)'
                              : 'rgba(245, 158, 11, 0.16)',
                          color:
                            __APP_CHANNEL__ === 'official'
                              ? 'var(--text-accent)'
                              : 'var(--text-warning)',
                        }}
                      >
                        {__APP_CHANNEL__ === 'official' ? 'Official Release' : 'Beta / Testing'}
                      </span>
                    </div>
                    <p className="settings-help">
                      YAOC (Yet Another OpenClaw Chat) is an independent client for OpenClaw.
                    </p>
                    <div className="session-detail-row">
                      <span className="session-detail-label">Version</span>
                      <span className="session-detail-value">{__APP_VERSION_LABEL__}</span>
                    </div>
                    <div className="session-detail-row">
                      <span className="session-detail-label">Build Timestamp</span>
                      <span className="session-detail-value">{__APP_BUILD_TIMESTAMP__}</span>
                    </div>
                    <div className="session-detail-row">
                      <span className="session-detail-label">Platform / Arch</span>
                      <span className="session-detail-value">
                        {sysInfo
                          ? `${sysInfo.platform} / ${sysInfo.arch}${sysInfo.runtime ? ` (${sysInfo.runtime})` : ''}`
                          : 'win32'}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {settingsTab === 'gateway' && (
                <div
                  className="settings-panel"
                  id="settings-panel-gateway"
                  role="tabpanel"
                  aria-labelledby="settings-tab-gateway"
                >
                  {activeProfile ? (
                    <>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <select
                          className="select-field"
                          aria-label="Gateway profile"
                          value={activeProfileId}
                          onChange={(e) => setActiveProfileId(e.target.value)}
                        >
                          {profiles.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        <button className="btn btn-primary" onClick={handleAddProfile}>
                          + New
                        </button>
                        {profiles.length > 1 && (
                          <button
                            className="btn btn-danger"
                            aria-label="Delete Gateway profile"
                            onClick={() => handleDeleteProfile(activeProfile.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>

                      <div className="form-row">
                        <label htmlFor="gateway-profile-name">Profile Name</label>
                        <input
                          id="gateway-profile-name"
                          className="input-field"
                          value={activeProfile.name}
                          onChange={(e) => updateActiveProfileField('name', e.target.value)}
                        />
                      </div>

                      <div className="form-row">
                        <label>
                          Gateway Endpoint (supports <code>http://</code>, <code>https://</code>,{' '}
                          <code>ws://</code>, <code>wss://</code>, or <code>mock://demo</code>)
                        </label>
                        <input
                          className="input-field"
                          placeholder="https://gateway.example.com or ws://127.0.0.1:18789"
                          value={activeProfile.endpoint}
                          onChange={(e) => updateActiveProfileField('endpoint', e.target.value)}
                        />
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div className="form-row">
                          <label>Gateway Auth Token (optional)</label>
                          <input
                            type="password"
                            className="input-field"
                            placeholder="gateway.auth.token"
                            value={activeProfile.token || ''}
                            onChange={(e) => updateActiveProfileField('token', e.target.value)}
                          />
                        </div>
                        <div className="form-row">
                          <label>Gateway Password (optional)</label>
                          <input
                            type="password"
                            className="input-field"
                            placeholder="gateway.auth.password"
                            value={activeProfile.password || ''}
                            onChange={(e) => updateActiveProfileField('password', e.target.value)}
                          />
                        </div>
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div className="form-row">
                          <label>Client ID</label>
                          <input
                            className="input-field"
                            value={activeProfile.clientId || 'gateway-client'}
                            onChange={(e) => updateActiveProfileField('clientId', e.target.value)}
                          />
                        </div>
                        <div className="form-row">
                          <label>Client Mode</label>
                          <input
                            className="input-field"
                            value={activeProfile.clientMode || 'ui'}
                            onChange={(e) => updateActiveProfileField('clientMode', e.target.value)}
                          />
                        </div>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={Boolean(activeProfile.allowInsecureTls)}
                            onChange={(e) =>
                              updateActiveProfileField('allowInsecureTls', e.target.checked)
                            }
                          />
                          <span>
                            Allow self-signed / private TLS certificates (for LAN / custom HTTPS)
                          </span>
                        </label>

                        <label
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={activeProfile.includeDeviceIdentity !== false}
                            onChange={(e) =>
                              updateActiveProfileField('includeDeviceIdentity', e.target.checked)
                            }
                          />
                          <span>Include Ed25519 Device Signature in Handshake (v3 protocol)</span>
                        </label>
                      </div>

                      {sysInfo?.deviceIdentity && (
                        <div
                          style={{
                            background: 'var(--bg-root)',
                            border: '1px solid var(--border-subtle)',
                            borderRadius: '8px',
                            padding: '10px 12px',
                            fontSize: '12px',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                              fontWeight: 600,
                              marginBottom: '4px',
                            }}
                          >
                            <Terminal size={13} />
                            <span>Client Ed25519 Device ID (for remote pairing)</span>
                          </div>
                          <code
                            style={{
                              display: 'block',
                              wordBreak: 'break-all',
                              color: 'var(--text-muted)',
                              fontSize: '11px',
                            }}
                          >
                            {sysInfo.deviceIdentity.deviceId}
                          </code>
                          <div
                            style={{
                              marginTop: '4px',
                              color: 'var(--text-muted)',
                              fontSize: '11px',
                            }}
                          >
                            If a remote Gateway requests device approval, run{' '}
                            <code>openclaw devices list</code> and{' '}
                            <code>openclaw devices approve &lt;requestId&gt;</code> on the host.
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <button className="btn btn-primary" onClick={handleAddProfile}>
                      + New Gateway Profile
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="settings-footer">
              <button className="btn" onClick={() => setShowProfileModal(false)}>
                Close
              </button>
              {settingsTab === 'gateway' && activeProfile && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    setShowProfileModal(false);
                    handleConnect(activeProfile);
                  }}
                >
                  <Plug size={14} /> Save & Connect
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Session Context Menu & Details Popup */}
      {sessionMenu &&
        (() => {
          const menuSession =
            sessions.find((s) => s.key === sessionMenu.sessionKey) || sessionMenu.session;
          if (!menuSession) return null;
          const displayName = getSessionDisplayName(menuSession);
          const isRenaming = renamingSessionKey === menuSession.key;
          const modelStr = typeof menuSession.model === 'string' ? menuSession.model : '';
          const providerStr =
            typeof menuSession.modelProvider === 'string' ? menuSession.modelProvider : '';
          const fullModel =
            providerStr && modelStr ? `${providerStr}/${modelStr}` : modelStr || providerStr;
          const kindStr = typeof menuSession.kind === 'string' ? menuSession.kind : '';
          const channelStr =
            typeof menuSession.channel === 'string'
              ? menuSession.channel
              : typeof menuSession.lastChannel === 'string'
                ? menuSession.lastChannel
                : '';
          const channelKind = [kindStr, channelStr].filter(Boolean).join(' • ');
          const thinkingStr =
            typeof menuSession.thinkingLevel === 'string' ? menuSession.thinkingLevel : '';
          const sessionIdStr =
            typeof menuSession.sessionId === 'string' ? menuSession.sessionId : '';

          return (
            <div
              className="session-popup"
              style={{ left: `${sessionMenu.x}px`, top: `${sessionMenu.y}px` }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="session-popup-header">
                <span className="session-popup-title" title={displayName}>
                  {displayName}
                </span>
                <button
                  type="button"
                  className="session-popup-close"
                  aria-label="Close session details"
                  onClick={() => {
                    setSessionMenu(null);
                    setRenamingSessionKey(null);
                  }}
                  title="Close"
                >
                  <X size={15} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>

              <div className="session-popup-details">
                <div className="session-detail-row">
                  <span className="session-detail-label">Key</span>
                  <span className="session-detail-value" title={String(menuSession.key)}>
                    #{String(menuSession.key)}
                  </span>
                </div>
                {typeof menuSession.agentId === 'string' && menuSession.agentId && (
                  <div className="session-detail-row">
                    <span className="session-detail-label">Agent</span>
                    <span className="session-detail-value">{menuSession.agentId}</span>
                  </div>
                )}
                {fullModel && (
                  <div className="session-detail-row">
                    <span className="session-detail-label">Model</span>
                    <span className="session-detail-value" title={fullModel}>
                      {fullModel}
                    </span>
                  </div>
                )}
                {channelKind && (
                  <div className="session-detail-row">
                    <span className="session-detail-label">Channel / Kind</span>
                    <span className="session-detail-value">{channelKind}</span>
                  </div>
                )}
                {thinkingStr && (
                  <div className="session-detail-row">
                    <span className="session-detail-label">Thinking</span>
                    <span className="session-detail-value">{thinkingStr}</span>
                  </div>
                )}
                {typeof menuSession.totalTokens === 'number' && (
                  <div className="session-detail-row">
                    <span className="session-detail-label">Tokens</span>
                    <span className="session-detail-value">
                      {menuSession.totalTokens.toLocaleString()}
                      {typeof menuSession.contextTokens === 'number' &&
                      menuSession.contextTokens > 0
                        ? ` / ${menuSession.contextTokens.toLocaleString()}`
                        : ''}
                    </span>
                  </div>
                )}
                {typeof menuSession.updatedAt === 'number' && menuSession.updatedAt > 0 && (
                  <div className="session-detail-row">
                    <span className="session-detail-label">Updated</span>
                    <span className="session-detail-value">
                      {new Date(menuSession.updatedAt).toLocaleString()}
                    </span>
                  </div>
                )}
                {sessionIdStr && (
                  <div className="session-detail-row">
                    <span className="session-detail-label">Session ID</span>
                    <span className="session-detail-value" title={sessionIdStr}>
                      {sessionIdStr}
                    </span>
                  </div>
                )}
              </div>

              {isRenaming ? (
                <div
                  style={{
                    display: 'flex',
                    gap: '6px',
                    padding: '4px 6px 6px',
                    alignItems: 'center',
                  }}
                >
                  <input
                    type="text"
                    className="input"
                    style={{ padding: '4px 8px', fontSize: '12px' }}
                    value={renameSessionInput}
                    autoFocus
                    placeholder="Session label..."
                    onChange={(e) => setRenameSessionInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        handleRenameSession(menuSession.key, renameSessionInput);
                      } else if (e.key === 'Escape') {
                        setRenamingSessionKey(null);
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    style={{ padding: '4px 8px', fontSize: '11px' }}
                    onClick={() => handleRenameSession(menuSession.key, renameSessionInput)}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  className="session-popup-item"
                  onClick={() => {
                    setRenamingSessionKey(menuSession.key);
                    setRenameSessionInput(displayName);
                  }}
                >
                  <Pencil size={13} /> Rename Session
                </button>
              )}

              <button
                className="session-popup-item"
                onClick={() => {
                  setSessionMenu(null);
                  handleResetSession(menuSession.key);
                }}
              >
                <RotateCcw size={13} /> Reset Session History
              </button>

              <div className="session-popup-divider" />

              <button
                className="session-popup-item danger"
                onClick={() => handleDeleteSession(menuSession.key)}
              >
                <Trash2 size={13} /> Delete Session
              </button>
            </div>
          );
        })()}

      {/* Fullscreen Image Lightbox Modal */}
      {lightboxImage && (
        <div className="lightbox-backdrop" onClick={() => setLightboxImage(null)}>
          <div className="lightbox-header" onClick={(e) => e.stopPropagation()}>
            <span className="lightbox-title">{lightboxImage.fileName}</span>
            <button
              type="button"
              className="btn"
              onClick={() => setLightboxImage(null)}
              title="Close (Esc)"
            >
              <X size={15} /> Close
            </button>
          </div>
          <img
            src={lightboxImage.url}
            alt={lightboxImage.fileName}
            className="lightbox-img"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Quit Confirmation Modal (Ctrl+Q) */}
      {showQuitConfirmModal && (
        <div className="modal-backdrop" onClick={() => setShowQuitConfirmModal(false)}>
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quit-confirm-title"
            style={{ maxWidth: '400px', gap: '14px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 id="quit-confirm-title" style={{ fontSize: '15.5px' }}>
                Quit YAOC?
              </h3>
              <button
                type="button"
                className="btn"
                aria-label="Cancel quit"
                onClick={() => setShowQuitConfirmModal(false)}
              >
                <X size={14} />
              </button>
            </div>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, margin: 0 }}>
              Press <code>Ctrl+Q</code> again to disconnect from the Gateway and exit the system
              tray completely. To hide the window to the system tray instead,{' '}
              {globalHotkey ? (
                <>
                  press <code>{globalHotkey}</code> or{' '}
                </>
              ) : null}
              close the window.
            </p>
            <div
              style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}
            >
              <button
                type="button"
                className="btn"
                autoFocus
                onClick={() => setShowQuitConfirmModal(false)}
              >
                Cancel (Esc)
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => window.openclawApi?.quitApp?.()}
              >
                Quit Completely (Ctrl+Q)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
