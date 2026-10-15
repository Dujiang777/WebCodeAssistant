import { useCallback, useMemo, useState, useEffect } from 'react';

import {
  api,
  MODEL_TIERS,
  loadUser,
  subscribeSession,
} from '../lib/api';
import type {
  AuthUser,
  ModelCatalog,
  ModelOption,
  PingResult,
  ProviderView,
  ProbeResult,
  SaveProviderBody,
} from '../lib/api';
import { messageOf } from '../lib/chat';
import {
  PROVIDER_PRESETS,
  contextLabel,
  costLabel,
  filterModels,
  matchPreset,
  type ModelSource,
  type ModelTier,
  type ProviderPreset,
} from '../lib/models';
import { PageBar } from '../components/PageBar';
import { CloseIcon, PlugIcon, PlusIcon, RefreshIcon, SearchIcon, TrashIcon } from '../components/icons';

/**
 * 模型服务页：选模型 + 配 Key + 试一句。
 *
 * 两个心智模型，页面也按这个顺序讲清楚：
 *   1. 「用平台的」—— 不用配任何东西，按模型单价扣积分；
 *   2. 「带自己的来」（BYOK）—— 点一家预设、贴 Key、拉模型、试一句，一轮都不扣积分。
 *
 * 密钥只回显尾号（****a1b2）：界面从头到尾拿不到明文，编辑时留空 = 不改。
 */

function priceLabel(model: ModelOption): string {
  if (model.byok) return '自带 Key · 免积分';
  return `每千输入 ${model.per1kInput} 分 · 每千输出 ${model.per1kOutput} 分`;
}

function TierBadge({ tier }: { tier: string }) {
  const meta = MODEL_TIERS[tier] ?? { label: tier, tone: 'mid' as const };
  return <span className={`ad-badge ad-tier-${meta.tone}`}>{meta.label}</span>;
}

function PingNote({ ping }: { ping: PingResult | null }) {
  if (!ping) return null;
  return (
    <div className={`md-ping${ping.ok ? '' : ' fail'}`}>
      {ping.ok ? ping.message : ping.message}
    </div>
  );
}

/* ------------------------------------------------------------------ 模型卡片 */

function ModelCard({ model, isDefault, busy, onSetDefault, onPing }: {
  model: ModelOption;
  isDefault: boolean;
  busy: boolean;
  onSetDefault: (model: ModelOption) => void;
  onPing: (model: ModelOption) => void;
}) {
  const pickable = model.available && !isDefault && !busy;
  return (
    <article
      className={`md-card${model.available ? '' : ' disabled'}${isDefault ? ' current' : ''}${pickable ? ' md-card-pick' : ''}`}
      style={{ animationDelay: '0ms' }}
      onClick={() => {
        if (pickable) onSetDefault(model);
      }}
    >
      <div className="md-card-head">
        <span className="md-card-name">{model.displayName}</span>
        <TierBadge tier={model.tier} />
      </div>
      <div className="md-card-provider dim">{model.providerName} · {model.modelKey}</div>
      <div className="md-card-price">{costLabel(model)}</div>
      <div className="md-card-meta">
        <span>{contextLabel(model.contextWindow)}</span>
        {!model.byok && <span>{priceLabel(model)}</span>}
      </div>

      {model.available ? (
        <div className="md-card-act" onClick={(event) => event.stopPropagation()}>
          {isDefault ? (
            <div className="md-card-current">✓ 当前默认模型</div>
          ) : (
            <button className="btn btn-sm" disabled={busy} onClick={() => onSetDefault(model)}>
              设为默认
            </button>
          )}
          <button className="btn btn-sm" disabled={busy} onClick={() => onPing(model)} title="发一句极短补全，确认真能说话">
            试一句
          </button>
        </div>
      ) : (
        <div className="md-card-reason" title={model.unavailableReason ?? ''}>
          {model.unavailableReason ?? '暂时不可用'}
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ 服务商卡片 */

function ProviderCard({ provider, canManage, onEdit, onDelete, onPing, busy }: {
  provider: ProviderView;
  canManage: boolean;
  onEdit: (provider: ProviderView) => void;
  onDelete: (provider: ProviderView) => void;
  onPing: (provider: ProviderView) => void;
  busy: boolean;
}) {
  const preset = matchPreset(provider.baseUrl);
  return (
    <article className={`md-provider${provider.ready ? '' : ' off'}`}>
      <div className="md-provider-head">
        <b className="md-provider-name">{provider.name}</b>
        {provider.scope === 'PLATFORM'
          ? <span className="ad-badge">平台提供</span>
          : <span className="ad-badge ad-badge-admin">我的 Key</span>}
        {preset && <span className="md-preset-tag">{preset.name}</span>}
        <span className={`dot ${provider.ready ? 'dot-ok' : 'dot-err'}`} title={provider.ready ? '可用' : provider.unavailableReason ?? ''} />
      </div>
      <div className="md-provider-meta dim">
        {provider.baseUrl}
        {provider.apiKeyHint && <span className="mono"> · Key {provider.apiKeyHint}</span>}
      </div>
      <div className="md-provider-models dim">
        {provider.models.length > 0
          ? `模型：${provider.models.map((model) => model.displayName).join('、')}`
          : '该服务商下没有可选模型'}
      </div>
      {provider.homepage && (
        <a className="md-provider-link" href={provider.homepage} target="_blank" rel="noreferrer">
          申请 Key 的地址 ↗
        </a>
      )}
      {!provider.ready && provider.unavailableReason && (
        <div className="md-card-reason">{provider.unavailableReason}</div>
      )}
      <div className="row">
        {provider.models.length > 0 && (
          <button className="btn btn-sm" disabled={busy} onClick={() => onPing(provider)} title="用这家的第一个模型试一句">
            试一句
          </button>
        )}
        {canManage && (
          <>
            <button className="btn btn-sm" disabled={busy} onClick={() => onEdit(provider)}>编辑</button>
            <button
              className="btn btn-sm btn-danger-ghost"
              disabled={busy}
              onClick={() => onDelete(provider)}
              title="删除这个自带服务商及其全部模型"
            >
              <TrashIcon size={12} /> 删除
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ 添加 / 编辑服务商模态 */

interface ProviderForm {
  id: number | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  homepage: string;
  models: string[];
}

function emptyForm(preset?: ProviderPreset): ProviderForm {
  return {
    id: null,
    name: preset?.name ?? '',
    baseUrl: preset?.baseUrl ?? '',
    apiKey: '',
    homepage: preset?.homepage ?? '',
    models: [],
  };
}

function ProviderDialog({ initial, onClose, onSaved }: {
  initial: ProviderForm;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const [form, setForm] = useState<ProviderForm>(initial);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [ping, setPing] = useState<PingResult | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState<'probe' | 'ping' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editing = form.id !== null;
  const activePreset = matchPreset(form.baseUrl);

  const applyPreset = (preset: ProviderPreset) => {
    setForm((current) => ({
      ...current,
      name: current.name.trim() && current.name !== activePreset?.name ? current.name : preset.name,
      baseUrl: preset.baseUrl,
      homepage: current.homepage.trim() && current.homepage !== activePreset?.homepage
        ? current.homepage
        : preset.homepage,
    }));
    setProbe(null);
    setPing(null);
  };

  const runProbe = async () => {
    setBusy('probe');
    setError(null);
    setProbe(null);
    try {
      const result = await api.probeModels({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        providerId: form.id ?? undefined,
      });
      setProbe(result);
      if (result.ok && form.models.length === 0 && result.models.length > 0) {
        setForm((current) => ({ ...current, models: [result.models[0]] }));
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const runPing = async () => {
    const model = form.models[0] ?? probe?.models[0] ?? '';
    setBusy('ping');
    setError(null);
    setPing(null);
    try {
      setPing(await api.pingModel({
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey.trim() || undefined,
        providerId: form.id ?? undefined,
        model,
      }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const body: SaveProviderBody = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        models: form.models,
        homepage: form.homepage.trim() || undefined,
      };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      if (editing) body.apiKey ||= undefined;
      await api.saveProvider(body, form.id ?? undefined);
      onSaved(editing ? `服务商「${body.name}」已更新。` : `服务商「${body.name}」已添加，模型可以选用了。`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleModel = (name: string) => {
    setForm((f) => ({
      ...f,
      models: f.models.includes(name)
        ? f.models.filter((m) => m !== name)
        : [...f.models, name],
    }));
  };

  const addManual = () => {
    const name = manual.trim();
    if (!name) return;
    setForm((current) => (
      current.models.includes(name) ? current : { ...current, models: [...current.models, name] }
    ));
    setManual('');
  };

  const listed = probe?.ok ? probe.models : form.models;
  const canSave = Boolean(form.name.trim() && form.baseUrl.trim() && (editing || (form.apiKey.trim() && form.models.length > 0)));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal md-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="配置模型服务商">
        <div className="modal-head">
          <PlugIcon size={15} />
          <span className="modal-title">{editing ? '编辑服务商' : '添加自带服务商'}</span>
          <div className="topbar-spacer" />
          <button className="icon-btn" title="关闭" onClick={onClose}><CloseIcon size={13} /></button>
        </div>

        <div className="modal-body">
          <div className="md-step">① 选一家，地址自动填好</div>
          <div className="md-presets">
            {PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`md-preset${activePreset?.id === preset.id ? ' on' : ''}`}
                onClick={() => applyPreset(preset)}
                title={preset.hint}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="md-step">② 给自己看的名字，和那串 Key</div>
          <div className="form-stack">
            <label className="ad-field">
              <span>名称（给自己看）</span>
              <input
                value={form.name}
                onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
                placeholder="例如：我的 DeepSeek"
                autoFocus
              />
            </label>
            <label className="ad-field">
              <span>接口地址（OpenAI 兼容的 /v1 地址）</span>
              <input
                value={form.baseUrl}
                onChange={(event) => setForm((f) => ({ ...f, baseUrl: event.target.value }))}
                placeholder="例如：https://api.deepseek.com/v1"
              />
            </label>
            <label className="ad-field">
              <span>
                API Key
                {editing && <em className="ad-field-note">已保存的只显示尾号；留空表示不修改</em>}
              </span>
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm((f) => ({ ...f, apiKey: event.target.value }))}
                placeholder={editing ? '不修改就留空' : 'sk-…'}
              />
            </label>
            <label className="ad-field">
              <span>申请 Key 的地址（可选）</span>
              <input
                value={form.homepage}
                onChange={(event) => setForm((f) => ({ ...f, homepage: event.target.value }))}
                placeholder="https://…"
              />
            </label>
          </div>

          <div className="md-step">③ 拉模型，再试一句确认会说话</div>
          <div className="row">
            <button
              className="btn btn-sm"
              disabled={busy !== null || !form.baseUrl.trim()}
              onClick={() => void runProbe()}
            >
              {busy === 'probe' && <span className="spinner" />}
              <RefreshIcon size={12} /> 拉取模型列表
            </button>
            <button
              className="btn btn-sm"
              disabled={busy !== null || !form.baseUrl.trim()}
              onClick={() => void runPing()}
              title="发一句极短补全。目录能列出来不等于能对话"
            >
              {busy === 'ping' && <span className="spinner" />}
              试一句
            </button>
            <span className="dim ad-probe-hint">填好地址和 Key 后点这里，不用手打模型名</span>
          </div>

          {probe && (
            <div className={`ad-probe-result${probe.ok ? '' : ' fail'}`}>
              {probe.ok ? (
                <>
                  <div className="ad-probe-ok">连接成功，发现 {probe.models.length} 个模型：</div>
                  <div className="row">
                    <button className="btn btn-sm" type="button" onClick={() => setForm((f) => ({ ...f, models: [...probe.models] }))}>
                      全选
                    </button>
                    <button className="btn btn-sm" type="button" onClick={() => setForm((f) => ({ ...f, models: [] }))}>
                      清空
                    </button>
                  </div>
                  <div className="ad-chip-wrap">
                    {probe.models.map((name) => (
                      <button
                        key={name}
                        className={`chip chip-btn${form.models.includes(name) ? ' chip-on' : ''}`}
                        onClick={() => toggleModel(name)}
                        title={form.models.includes(name) ? '点击取消选用' : '点击选用这个模型'}
                      >
                        {form.models.includes(name) ? '✓ ' : '+ '}{name}
                      </button>
                    ))}
                  </div>
                  {form.models.length === 0 && (
                    <div className="dim ad-probe-hint">点上面的模型名选用（选中的才会出现在对话的模型列表里）</div>
                  )}
                </>
              ) : (
                <div className="form-error">{probe.message}</div>
              )}
            </div>
          )}

          <div className="md-manual">
            <input
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addManual();
                }
              }}
              placeholder="目录没有时，手动填一个模型名"
            />
            <button className="btn btn-sm" type="button" disabled={!manual.trim()} onClick={addManual}>
              加入选用
            </button>
          </div>

          {form.models.length > 0 && (
            <div className="dim ad-probe-hint">
              将保存的模型：{form.models.join('、')}
              {listed.length > 0 && form.models.length !== listed.length ? ` · 已选 ${form.models.length}` : ''}
            </div>
          )}

          <PingNote ping={ping} />
          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <div className="topbar-spacer" />
          <button
            className="btn btn-primary"
            disabled={busy !== null || !canSave}
            onClick={() => void save()}
          >
            {busy === 'save' && <span className="spinner" />}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/* ====================================================================== 页面 */

export function ModelsPage({ onBack, onLogout, onModelChanged }: {
  onBack: () => void;
  onLogout: () => void;
  /** 切换默认模型后通知 IDE 页刷新对话定价（当前会话的余额 chip 等）。 */
  onModelChanged?: () => void;
}) {
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyModel, setBusyModel] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ProviderForm | null>(null);
  const [deleting, setDeleting] = useState<ProviderView | null>(null);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<ModelSource>('all');
  const [tier, setTier] = useState<ModelTier>('all');
  const [ping, setPing] = useState<PingResult | null>(null);

  useEffect(() => subscribeSession(setUser), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await api.modelCatalog());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setDefault = async (model: ModelOption) => {
    setBusyModel(model.modelKey);
    setError(null);
    try {
      await api.setDefaultModel(model.modelKey);
      await load();
      onModelChanged?.();
      setNotice(`已把「${model.displayName}」设为默认模型，之后的对话会优先用它。`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyModel(null);
    }
  };

  const followPlatform = async () => {
    setBusyModel('__platform__');
    try {
      await api.setDefaultModel('');
      await load();
      onModelChanged?.();
      setNotice('已恢复跟随平台默认。');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyModel(null);
    }
  };

  const pingCatalog = async (model: ModelOption) => {
    setBusyModel('ping-' + model.modelKey);
    setError(null);
    setPing(null);
    try {
      setPing(await api.pingModel({ modelKey: model.modelKey }));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyModel(null);
    }
  };

  const pingProvider = async (provider: ProviderView) => {
    const first = provider.models[0];
    if (!first) return;
    if (provider.scope === 'USER') {
      setBusyModel('ping-p-' + provider.id);
      setError(null);
      setPing(null);
      try {
        setPing(await api.pingModel({
          baseUrl: provider.baseUrl,
          providerId: provider.id,
          model: first.modelKey,
        }));
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusyModel(null);
      }
      return;
    }
    await pingCatalog(first);
  };

  const removeProvider = async (provider: ProviderView) => {
    setBusyModel('del-' + provider.id);
    setError(null);
    try {
      await api.deleteProvider(provider.id);
      setDeleting(null);
      await load();
      setNotice(`服务商「${provider.name}」及其 ${provider.models.length} 个模型已删除。`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyModel(null);
    }
  };

  const platformProviders = (catalog?.providers ?? []).filter((p) => p.scope === 'PLATFORM');
  const userProviders = (catalog?.providers ?? []).filter((p) => p.scope === 'USER');
  const defaultKey = catalog?.defaultModelKey ?? null;
  const platformModels = (catalog?.models ?? []).filter((m) => !m.byok);
  const byokModels = (catalog?.models ?? []).filter((m) => m.byok);
  const chosen = (catalog?.models ?? []).find((m) => m.modelKey === defaultKey) ?? null;
  const fallback = platformModels.find((m) => m.available) ?? null;
  const defaultModel = chosen ?? fallback;
  const following = !chosen && !!fallback;
  const currentKey = defaultModel?.modelKey ?? null;
  const filtered = useMemo(
    () => filterModels(catalog?.models ?? [], query, source, tier),
    [catalog, query, source, tier],
  );
  const userLimit = (catalog?.providers ?? []).filter((p) => p.scope === 'USER').length >= 8;

  return (
    <div className="page">
      <PageBar
        title="模型服务"
        subtitle={user?.username ?? ''}
        balance={user?.credits ?? null}
        lowBalance={user?.lowBalance ?? false}
        active="models"
        isAdmin={user?.role === 'ADMIN'}
        onBack={onBack}
        onLogout={onLogout}
      />

      <main className="page-scroll">
        <div className="page-wrap">
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}

          <section className="ad-panel md-hero">
            <div className="md-hero-main">
              <span className="cr-balance-label">对话使用的默认模型</span>
              <div className="md-hero-name">
                {loading ? '读取中…' : defaultModel ? defaultModel.displayName : '还没有可用模型'}
                {defaultModel && <TierBadge tier={defaultModel.tier} />}
                {following && <span className="ad-badge">跟随平台</span>}
              </div>
              <div className="dim">
                {defaultModel
                  ? `${following ? '未指定时用平台推荐 · ' : ''}${defaultModel.byok ? '自带 Key · 本轮不扣积分' : '按真实用量结算，多退少补'} · ${defaultModel.providerName}`
                  : '平台还没配密钥。下面点一家预设，贴上自己的 Key 就能用'}
              </div>
              {defaultModel && (
                <div className="md-hero-stats">
                  <div className="md-stat">
                    <span className="md-stat-k">上下文</span>
                    <span className="md-stat-v">{contextLabel(defaultModel.contextWindow)}</span>
                  </div>
                  <div className="md-stat">
                    <span className="md-stat-k">大约一轮</span>
                    <span className="md-stat-v">{costLabel(defaultModel)}</span>
                  </div>
                  <div className="md-stat">
                    <span className="md-stat-k">调用名</span>
                    <span className="md-stat-v mono">{defaultModel.modelKey}</span>
                  </div>
                </div>
              )}
              <PingNote ping={ping} />
            </div>
            <div className="md-hero-actions">
              {defaultModel && (
                <button className="btn btn-sm" disabled={busyModel !== null} onClick={() => void pingCatalog(defaultModel)}>
                  {busyModel?.startsWith('ping-') && <span className="spinner" />}
                  试一句
                </button>
              )}
              {chosen && (
                <button className="btn btn-sm" disabled={busyModel !== null} onClick={() => void followPlatform()}>
                  恢复跟随平台默认
                </button>
              )}
            </div>
          </section>

          <section className="ad-panel">
            <h2 className="page-h2">
              可选模型
              <span className="page-h2-note">
                点卡片即设为默认。平台模型按用量扣积分{catalog?.byokFree ? '；自带 Key 不扣' : ''}
              </span>
            </h2>
            <div className="md-filter">
              <label className="md-search">
                <SearchIcon size={13} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜名称、调用名、服务商"
                />
              </label>
              <div className="md-facets">
                {([
                  ['all', '全部'],
                  ['platform', '平台'],
                  ['byok', '自带 Key'],
                ] as const).map(([id, label]) => (
                  <button key={id} type="button" className={`md-facet${source === id ? ' on' : ''}`} onClick={() => setSource(id)}>
                    {label}
                  </button>
                ))}
              </div>
              <div className="md-facets">
                {([
                  ['all', '不限档'],
                  ['LIGHT', '轻量'],
                  ['STANDARD', '标准'],
                  ['FLAGSHIP', '旗舰'],
                ] as const).map(([id, label]) => (
                  <button key={id} type="button" className={`md-facet${tier === id ? ' on' : ''}`} onClick={() => setTier(id)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="md-grid">
              {(query || source !== 'all' || tier !== 'all' ? filtered : platformModels).map((model) => (
                <ModelCard
                  key={model.modelKey}
                  model={model}
                  isDefault={model.modelKey === currentKey}
                  busy={busyModel !== null}
                  onSetDefault={(m) => void setDefault(m)}
                  onPing={(m) => void pingCatalog(m)}
                />
              ))}
            </div>
            {!loading && (query || source !== 'all' || tier !== 'all') && filtered.length === 0 && (
              <div className="md-empty">没有符合筛选的模型。</div>
            )}
          </section>

          <section className="ad-panel">
            <h2 className="page-h2">
              我的 Key
              <span className="page-h2-note">
                点一家预设 → 贴 Key → 拉模型 → 试一句。这部分对话不消耗平台积分 · {userProviders.length}/8
              </span>
            </h2>
            {userProviders.length === 0 && (
              <div className="md-empty">
                <p>还没有自带服务商。下面点一家，地址会填好，你只需要贴 Key。</p>
                <div className="md-presets">
                  {PROVIDER_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="md-preset"
                      disabled={userLimit}
                      title={preset.hint}
                      onClick={() => setDialog(emptyForm(preset))}
                    >
                      {preset.name}
                      <em>{preset.hint}</em>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {byokModels.length > 0 && source !== 'platform' && (
              <div className="md-grid">
                {byokModels.map((model) => (
                  <ModelCard
                    key={'byok-' + model.modelKey}
                    model={model}
                    isDefault={model.modelKey === currentKey}
                    busy={busyModel !== null}
                    onSetDefault={(m) => void setDefault(m)}
                    onPing={(m) => void pingCatalog(m)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="ad-panel">
            <h2 className="page-h2">
              模型服务商
              <span className="page-h2-note">平台服务商由平台维护 Key；「我的 Key」部分在这里增删改</span>
            </h2>

            <div className="md-provider-grid">
              {platformProviders.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  canManage={false}
                  busy={busyModel !== null}
                  onEdit={() => undefined}
                  onDelete={() => undefined}
                  onPing={(p) => void pingProvider(p)}
                />
              ))}
              {userProviders.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  canManage
                  busy={busyModel === 'del-' + provider.id || busyModel === 'ping-p-' + provider.id}
                  onEdit={(p) => setDialog({
                    id: p.id,
                    name: p.name,
                    baseUrl: p.baseUrl,
                    apiKey: '',
                    homepage: p.homepage ?? '',
                    models: p.models.map((m) => m.modelKey),
                  })}
                  onDelete={(p) => setDeleting(p)}
                  onPing={(p) => void pingProvider(p)}
                />
              ))}
            </div>

            <button
              className="btn btn-primary md-add"
              disabled={userLimit}
              onClick={() => setDialog(emptyForm())}
              title="最多添加 8 个自带服务商"
            >
              <PlusIcon size={13} /> 添加自带服务商
            </button>
          </section>
        </div>
      </main>

      {dialog && (
        <ProviderDialog
          initial={dialog}
          onClose={() => setDialog(null)}
          onSaved={(text) => {
            setDialog(null);
            setNotice(text);
            void load();
          }}
        />
      )}

      {deleting && (
        <div className="modal-backdrop" onClick={() => setDeleting(null)}>
          <div className="modal ad-modal ad-modal-danger" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="删除服务商">
            <div className="modal-head">
              <PlugIcon size={15} />
              <span className="modal-title">删除服务商 · {deleting.name}</span>
              <div className="topbar-spacer" />
              <button className="icon-btn" title="关闭" onClick={() => setDeleting(null)}><CloseIcon size={13} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-note">
                将删除这个服务商和你保存的 Key，以及它下面的 {deleting.models.length} 个模型
                {deleting.models.some((m) => m.modelKey === defaultKey) ? '。注意：它正是当前默认模型，删除后会回退到平台默认' : ''}。
                平台模型不受影响。
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setDeleting(null)}>取消</button>
              <div className="topbar-spacer" />
              <button
                className="btn btn-primary btn-danger"
                disabled={busyModel !== null}
                onClick={() => void removeProvider(deleting)}
              >
                {busyModel !== null && <span className="spinner" />}
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
