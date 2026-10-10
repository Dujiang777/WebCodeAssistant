import { useCallback, useEffect, useState } from 'react';

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
  ProviderView,
  ProbeResult,
  SaveProviderBody,
} from '../lib/api';
import { messageOf } from '../lib/chat';
import { FilmSprocket } from '../components/FilmSprocket';
import { PageBar } from '../components/PageBar';
import { CloseIcon, PlugIcon, PlusIcon, RefreshIcon, TrashIcon } from '../components/icons';

/**
 * 模型服务页：选模型 + 配 Key。
 *
 * 两个心智模型，页面也按这个顺序讲清楚：
 *   1. 「用平台的」—— 不用配任何东西，按模型单价扣积分；
 *   2. 「带自己的来」（BYOK）—— 填服务商地址和 API Key，模型随便用，一轮都不扣积分。
 *
 * 密钥只回显尾号（****a1b2）：界面从头到尾拿不到明文，编辑时留空 = 不改。
 */

/** 每千 token 单价的人话描述。 */
function priceLabel(model: ModelOption): string {
  if (model.byok) return '自带 Key · 免积分';
  return `每千输入 ${model.per1kInput} 分 · 每千输出 ${model.per1kOutput} 分`;
}

function TierBadge({ tier }: { tier: string }) {
  const meta = MODEL_TIERS[tier] ?? { label: tier, tone: 'mid' as const };
  return <span className={`ad-badge ad-tier-${meta.tone}`}>{meta.label}</span>;
}

/* ------------------------------------------------------------------ 模型卡片 */

function ModelCard({ model, isDefault, busy, onSetDefault }: {
  model: ModelOption;
  isDefault: boolean;
  busy: boolean;
  onSetDefault: (model: ModelOption) => void;
}) {
  return (
    <article
      className={`md-card${model.available ? '' : ' disabled'}${isDefault ? ' current' : ''}`}
      style={{ animationDelay: '0ms' }}
    >
      <div className="md-card-head">
        <span className="md-card-name">{model.displayName}</span>
        <TierBadge tier={model.tier} />
      </div>
      <div className="md-card-provider dim">{model.providerName} · {model.modelKey}</div>
      <div className="md-card-price">{priceLabel(model)}</div>

      {model.available ? (
        isDefault ? (
          <div className="md-card-current">✓ 当前默认模型</div>
        ) : (
          <button className="btn btn-sm" disabled={busy} onClick={() => onSetDefault(model)}>
            设为默认
          </button>
        )
      ) : (
        <div className="md-card-reason" title={model.unavailableReason ?? ''}>
          {model.unavailableReason ?? '暂时不可用'}
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ 服务商卡片 */

function ProviderCard({ provider, canManage, onEdit, onDelete, busy }: {
  provider: ProviderView;
  canManage: boolean;
  onEdit: (provider: ProviderView) => void;
  onDelete: (provider: ProviderView) => void;
  busy: boolean;
}) {
  return (
    <article className={`md-provider${provider.ready ? '' : ' off'}`}>
      <div className="md-provider-head">
        <b className="md-provider-name">{provider.name}</b>
        {provider.scope === 'PLATFORM'
          ? <span className="ad-badge">平台提供</span>
          : <span className="ad-badge ad-badge-admin">我的 Key</span>}
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
      {canManage && (
        <div className="row">
          <button className="btn btn-sm" disabled={busy} onClick={() => onEdit(provider)}>编辑</button>
          <button
            className="btn btn-sm btn-danger-ghost"
            disabled={busy}
            onClick={() => onDelete(provider)}
            title="删除这个自带服务商及其全部模型"
          >
            <TrashIcon size={12} /> 删除
          </button>
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ 添加 / 编辑服务商模态 */

interface ProviderForm {
  id: number | null;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

function ProviderDialog({ initial, onClose, onSaved }: {
  initial: ProviderForm;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const [form, setForm] = useState<ProviderForm>(initial);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [busy, setBusy] = useState<'probe' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editing = form.id !== null;

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
      };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      if (editing) body.apiKey ||= undefined; // 留空 = 不改密钥
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
          </div>

          <div className="row">
            <button
              className="btn btn-sm"
              disabled={busy !== null || !form.baseUrl.trim()}
              onClick={() => void runProbe()}
            >
              {busy === 'probe' && <span className="spinner" />}
              <RefreshIcon size={12} /> 拉取模型列表
            </button>
            <span className="dim ad-probe-hint">填好地址和 Key 后点这里，不用手打模型名</span>
          </div>

          {probe && (
            <div className={`ad-probe-result${probe.ok ? '' : ' fail'}`}>
              {probe.ok ? (
                <>
                  <div className="ad-probe-ok">连接成功，发现 {probe.models.length} 个模型：</div>
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

          {form.models.length > 0 && (
            <div className="dim ad-probe-hint">将保存的模型：{form.models.join('、')}</div>
          )}

          {error && <div className="form-error">{error}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <div className="topbar-spacer" />
          <button
            className="btn btn-primary"
            disabled={busy !== null || !form.name.trim() || !form.baseUrl.trim()}
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
  const defaultModel = (catalog?.models ?? []).find((m) => m.modelKey === defaultKey) ?? null;
  const platformModels = (catalog?.models ?? []).filter((m) => !m.byok);
  const byokModels = (catalog?.models ?? []).filter((m) => m.byok);

  return (
    <div className="page">
      <PageBar
        title="模型服务"
        subtitle={user?.username ?? ''}
        balance={null}
        lowBalance={false}
        active="models"
        onBack={onBack}
        onLogout={onLogout}
      />

      <main className="page-scroll">
        <div className="page-wrap">
          <FilmSprocket variant="page" />
          <p className="page-kicker">OPTICS · MODELS</p>
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}

          {/* ------------------------------------------------------ 当前默认 */}
          <section className="ad-panel md-hero">
            <div className="md-hero-main">
              <span className="cr-balance-label">对话使用的默认模型</span>
              <div className="md-hero-name">
                {loading ? '读取中…' : defaultModel ? defaultModel.displayName : '跟随平台默认'}
                {defaultModel && <TierBadge tier={defaultModel.tier} />}
              </div>
              <div className="dim">
                {defaultModel
                  ? `${priceLabel(defaultModel)} · 每轮对话按真实用量结算，多退少补`
                  : '未指定时自动使用平台当前推荐的模型'}
              </div>
            </div>
            {defaultModel && (
              <button className="btn btn-sm" disabled={busyModel !== null} onClick={() => void followPlatform()}>
                恢复跟随平台默认
              </button>
            )}
          </section>

          {/* ------------------------------------------------------ 平台模型 */}
          <section className="ad-panel">
            <h2 className="page-h2">
              平台模型
              <span className="page-h2-note">
                平台统一维护的模型，直接选用即可{catalog?.byokFree ? '；自带 Key 的模型不扣积分' : ''}
              </span>
            </h2>
            <div className="md-grid">
              {platformModels.map((model) => (
                <ModelCard
                  key={model.modelKey}
                  model={model}
                  isDefault={model.modelKey === defaultKey}
                  busy={busyModel !== null}
                  onSetDefault={(m) => void setDefault(m)}
                />
              ))}
            </div>
          </section>

          {/* ------------------------------------------------------ 自带 Key 模型 */}
          {(byokModels.length > 0 || userProviders.length > 0) && (
            <section className="ad-panel">
              <h2 className="page-h2">
                我的模型（自带 Key）
                <span className="page-h2-note">用你自己的 API Key 调用，这一部分对话不消耗平台积分</span>
              </h2>
              <div className="md-grid">
                {byokModels.map((model) => (
                  <ModelCard
                    key={model.modelKey}
                    model={model}
                    isDefault={model.modelKey === defaultKey}
                    busy={busyModel !== null}
                    onSetDefault={(m) => void setDefault(m)}
                  />
                ))}
              </div>
            </section>
          )}

          {/* ------------------------------------------------------ 服务商 */}
          <section className="ad-panel">
            <h2 className="page-h2">
              模型服务商
              <span className="page-h2-note">平台服务商由平台维护 Key；「我的 Key」部分在这里增删改</span>
            </h2>

            <div className="md-provider-grid">
              {platformProviders.map((provider) => (
                <ProviderCard key={provider.id} provider={provider} canManage={false} busy={false}
                  onEdit={() => undefined} onDelete={() => undefined} />
              ))}
              {userProviders.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  canManage
                  busy={busyModel === 'del-' + provider.id}
                  onEdit={(p) => setDialog({
                    id: p.id,
                    name: p.name,
                    baseUrl: p.baseUrl,
                    apiKey: '',
                    models: p.models.map((m) => m.modelKey),
                  })}
                  onDelete={(p) => setDeleting(p)}
                />
              ))}
            </div>

            <button
              className="btn btn-primary md-add"
              disabled={(catalog?.providers ?? []).filter((p) => p.scope === 'USER').length >= 8}
              onClick={() => setDialog({ id: null, name: '', baseUrl: '', apiKey: '', models: [] })}
              title="最多添加 8 个自带服务商"
            >
              <PlusIcon size={13} /> 添加自带服务商
            </button>
          </section>
        </div>
      </main>

      {/* 添加 / 编辑服务商 */}
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

      {/* 删除确认 */}
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
