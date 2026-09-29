/**
 * 免费额度用完后的引导弹窗。
 *
 * 设计原则：此刻用户最关心的是「我还能不能用、要怎么做」，所以
 * 不堆营销文案，直接给两条路 —— 配自己的 Key（推荐、一次配置长期用）
 * 或等下周重置。教程写成可跟着一步步敲的清单，每步都说清「在哪、点什么」。
 */
export function QuotaGuideModal({
  open,
  onClose,
  onGoModels,
}: {
  open: boolean;
  onClose: () => void;
  onGoModels: () => void;
}) {
  if (!open) {
    return null;
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal quota-guide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="dot dot-warn" />
          <span className="modal-title">本周免费额度已用完</span>
          <div className="topbar-spacer" />
          <button className="icon-btn" title="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="quota-guide-body">
          <p className="quota-guide-lead">
            每周会自动重置 <b>500 分</b>免费额度（约 ¥5 的模型消耗）。
            等不及的话，配置<b>你自己的 API Key</b> 即可继续 —— 自带 Key
            的模型<b>不消耗平台积分</b>，算力费用直接走你自己的模型账号。
          </p>

          <div className="quota-guide-steps">
            <div className="quota-guide-step-title">配置教程（约 3 分钟）</div>
            <ol>
              <li>
                打开 DeepSeek 开放平台{' '}
                <a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">
                  platform.deepseek.com
                </a>
                ，注册或登录（支持手机号 / 微信）。
              </li>
              <li>
                左侧菜单选 <b>API Keys</b> → 点 <b>创建 API key</b>，随便起个名字（比如
                <code>wca</code>）。
              </li>
              <li>
                复制弹出的密钥（<code>sk-</code> 开头）。<b>只显示这一次</b>，关掉就再也看不到了，
                建议先存到备忘录。
              </li>
              <li>
                回到本站 → 点输入框旁的<b>头像</b> → <b>模型服务</b> → 找到 DeepSeek，
                把密钥粘进 <b>API Key</b> 输入框 → 保存。
              </li>
              <li>
                在模型列表里选中带「自带 Key」标记的模型，回编辑器继续对话 —— 不再受额度限制。
              </li>
            </ol>
          </div>

          <p className="quota-guide-note">
            你的 Key 使用 AES-GCM 加密后存放在你自己的账号里，平台服务端也无法看到明文；
            也可以随时在「模型服务」里删除。本周额度重置后不配置 Key 也能继续用。
          </p>
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>
            等下周重置
          </button>
          <button className="btn btn-primary" onClick={onGoModels}>
            去配置 API Key
          </button>
        </div>
      </div>
    </div>
  );
}
