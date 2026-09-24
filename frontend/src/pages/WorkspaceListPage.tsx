import { useEffect, useRef, useState } from 'react';

import { api, formatBytes, loadUser, subscribeSession } from '../lib/api';
import type { AuthUser, HealthInfo, Workspace } from '../lib/api';
import { messageOf } from '../lib/chat';
import { navigate } from '../lib/router';
import { TerminalMark, FolderOpenIcon, PlusIcon, RefreshIcon } from '../components/icons';

/**
 * 工作区列表 + 创建工作区。
 *
 * 创建工作区是这个产品最容易劝退人的一步，所以三种入口（内置示例 / Git 克隆 / ZIP 上传）
 * 全部平铺在一个界面上，不做二级页面：内置示例排在最前，让第一次使用的人
 * 不用准备任何东西就能看到完整的「读代码 → 出补丁 → 应用」流程。
 */
interface WorkspaceListPageProps {
  username: string;
  onLogout: () => void;
}

type CreateMode = 'sample' | 'git' | 'zip';

export function WorkspaceListPage({ username, onLogout }: WorkspaceListPageProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 积分与邮箱验证状态挂在会话上，顶栏那枚徽标与这里的入口都用它。 */
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());

  const [mode, setMode] = useState<CreateMode>('sample');
  const [name, setName] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, info] = await Promise.all([api.listWorkspaces(), api.health()]);
      setWorkspaces(list);
      setHealth(info);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => subscribeSession(setUser), []);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'sample') {
        setProgress('正在把内置演示项目铺到工作区目录…');
        const workspace = await api.createSampleWorkspace(name.trim() || undefined);
        setWorkspaces((list) => [workspace, ...list]);
        navigate(`/ide/${workspace.id}`);
      } else if (mode === 'git') {
        setProgress('正在浅克隆（depth=1）…大仓库可能要等十几秒');
        // 名称留空由后端按仓库名推导，这里直接传空串即可
        const workspace = await api.createWorkspaceFromGit(name.trim(), gitUrl.trim());
        setWorkspaces((list) => [workspace, ...list]);
        navigate(`/ide/${workspace.id}`);
      } else {
        if (!zipFile) {
          throw new Error('请先选择一个 zip 文件');
        }
        setProgress('正在解压并校验压缩包…');
        const workspace = await api.createWorkspaceFromZip(zipFile, name.trim() || undefined);
        setWorkspaces((list) => [workspace, ...list]);
        navigate(`/ide/${workspace.id}`);
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const canSubmit =
    !busy &&
    ((mode === 'sample') || (mode === 'git' && gitUrl.trim().length > 0) || (mode === 'zip' && zipFile !== null));

  return (
    <div className="centered-page" style={{ alignItems: 'flex-start' }}>
      <div className="card wide" style={{ marginTop: 12 }}>
        <div className="card-head">
          <TerminalMark size={24} />
          <div>
            <div className="card-title">选择工作区</div>
            <div className="card-desc" style={{ marginBottom: 0 }}>
              每个工作区是服务器磁盘上的一个真实目录。当前账号：{username}
            </div>
          </div>
          <div className="topbar-spacer" />
          {user && (
            <button
              className={`chip chip-btn${user.lowBalance ? ' chip-warn' : ''}`}
              onClick={() => navigate('/credits')}
              title="剩余积分。点开查看账单、套餐与充值。"
            >
              {user.lowBalance && <span className="dot dot-err" />}
              积分 {user.credits}
            </button>
          )}
          <button className="btn btn-sm" onClick={() => navigate('/credits')} title="积分中心：账单 / 套餐 / 充值">
            积分中心
          </button>
          <button className="btn btn-sm" onClick={() => navigate('/account')} title="账号与安全：邮箱验证 / 改密码 / 登录设备">
            账号
          </button>
          <button className="btn btn-sm" onClick={() => void load()} disabled={loading}>
            <RefreshIcon size={13} />
            刷新
          </button>
          <button className="btn btn-sm" onClick={onLogout}>
            退出
          </button>
        </div>

        {user && !user.emailVerified && (
          <div className="banner banner-credit">
            <span className="dot dot-warn" />
            <span className="banner-text">
              邮箱 <b>{user.email ?? ''}</b> 还没有验证。验证之后才能用它找回密码。
            </span>
            <button className="btn btn-sm" onClick={() => navigate('/account')}>
              去验证
            </button>
          </div>
        )}

        <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          <span className="chip" title="后端是否可以调用模型">
            <span className={`dot ${health?.modelConfigured ? 'dot-ok' : 'dot-warn'}`} />
            {health?.modelConfigured ? `模型就绪 · ${health.model}` : '未配置模型（仍可浏览与编辑）'}
          </span>
          <span className="chip">检索引擎 · {health?.grepEngine ?? '—'}</span>
          <span className="chip">
            <span className={`dot ${health?.redisAvailable ? 'dot-ok' : 'dot-warn'}`} />
            Redis {health?.redisAvailable ? '可用' : '降级为进程内限流'}
          </span>
        </div>

        <div className="section-divider">新建工作区</div>

        <div className="tabs">
          <button className={`tab${mode === 'sample' ? ' active' : ''}`} onClick={() => setMode('sample')}>
            内置示例（最快）
          </button>
          <button className={`tab${mode === 'git' ? ' active' : ''}`} onClick={() => setMode('git')}>
            Git 克隆
          </button>
          <button className={`tab${mode === 'zip' ? ' active' : ''}`} onClick={() => setMode('zip')}>
            ZIP 上传
          </button>
        </div>

        <div className="form-stack" style={{ marginTop: 14 }}>
          <div className="row" style={{ alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            <div className="field" style={{ flex: '1 1 200px', minWidth: 180 }}>
              <label htmlFor="ws-name">名称（可选）</label>
              <input
                id="ws-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={mode === 'sample' ? 'demo-java' : mode === 'git' ? '留空则用仓库名' : '留空则用压缩包名'}
              />
            </div>

            {mode === 'git' && (
              <div className="field" style={{ flex: '2 1 340px', minWidth: 260 }}>
                <label htmlFor="ws-git">Git 地址</label>
                <input
                  id="ws-git"
                  className="input mono"
                  value={gitUrl}
                  onChange={(event) => setGitUrl(event.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                />
              </div>
            )}

            {mode === 'zip' && (
              <div className="field" style={{ flex: '2 1 340px', minWidth: 260 }}>
                <label>压缩包</label>
                <div className="row">
                  <button className="btn" onClick={() => fileInputRef.current?.click()}>
                    <FolderOpenIcon size={13} />
                    选择 .zip
                  </button>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--fg-2)' }}>
                    {zipFile ? `${zipFile.name} · ${formatBytes(zipFile.size)}` : '未选择文件'}
                  </span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip,application/zip"
                    style={{ display: 'none' }}
                    onChange={(event) => setZipFile(event.target.files?.[0] ?? null)}
                  />
                </div>
              </div>
            )}

            <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void create()}>
              {busy ? <span className="spinner" /> : <PlusIcon size={13} />}
              创建工作区
            </button>
          </div>

          {progress && <div className="form-ok">{progress}</div>}
          {error && <div className="form-error">{error}</div>}

          {mode === 'sample' && (
            <div className="hint-box">
              内置示例是一个刻意留了问题的 Spring Boot 项目：<span className="mono">UserService</span> 用了字段注入，
              而项目自带的 <span className="mono">.coding-rules.md</span> 要求构造器注入。
              打开它、让 AI 看一眼，就能完整跑通「读代码 → 出补丁 → 应用 → 文件真的变了」。
            </div>
          )}
        </div>

        <div className="section-divider">我的工作区（{workspaces.length}）</div>

        {loading ? (
          <div className="loading-block">
            <span className="spinner" />
            <span>正在加载工作区…</span>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="empty">
            <div className="empty-title">还没有工作区</div>
            <div className="empty-text">用上面的「内置示例」一键创建，几秒后就能进入编辑器。</div>
          </div>
        ) : (
          <div className="workspace-list">
            {workspaces.map((workspace) => (
              <div
                key={workspace.id}
                className="workspace-row"
                onClick={() => navigate(`/ide/${workspace.id}`)}
                title="打开这个工作区"
              >
                <FolderOpenIcon size={18} />
                <div className="workspace-row-body">
                  <div className="workspace-name">{workspace.name}</div>
                  <div className="workspace-meta">
                    {workspace.gitUrl ?? '本地导入'} · {formatBytes(workspace.sizeBytes)} · 创建于{' '}
                    {new Date(workspace.createdAt).toLocaleString()}
                  </div>
                </div>
                <span className="chip">打开 →</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
