/**
 * dsh-computer-use — 浏览器半边。
 *
 * **加载形态**：宿主把客户端产物当作普通脚本注入，脚本要做的是调用
 * `window.__ModuleLoader__.load({ id, factory })` 注册一个工厂；工厂收到的
 * `require` 是宿主的模块表（React 从这里拿），返回 `{ inject, apply }`。
 *
 * 这里曾经写成 ESM（`export const name` / `export function apply`）——那是错的：
 * 脚本里出现 `export` 是语法错误，注册根本不会发生，启动期就卡在等这个模块。
 * 正确形状照 `dsh-file-drop/lib/client.js` 与 `dsh-better-sidebar/lib/client.js`。
 *
 * 职责只有一件：把"现在允许哪条输入通道"这个开关放到用户手边。两处入口共用
 * 同一份远端状态：
 * - `settings.section`：完整设置页；
 * - `conversation.input.left`：输入框左侧的紧凑切换。
 *
 * 三条纪律：不缓存真相（模式由 Host 持有）、失败要说出来（宿主旧构建没有路由
 * 时显示原因，而不是假装切换成功）、不碰别人的 DOM。
 */
;(function register() {
  const loader = typeof window === 'undefined' ? undefined : window.__ModuleLoader__;
  if (loader === undefined || typeof loader.load !== 'function') return;

  loader.load({
    id: 'dsh-computer-use',
    factory(require) {
      /** 状态路由；与 Host 端 `src/route.ts` 的常量保持一致。 */
      const STATE_PATH = '/dsh-computer-use/state';

      /** 模式文案。 */
      const TEXT = {
        zh: {
          title: 'Computer Use',
          description: '决定模型能用哪条通道操作桌面。窗口模式不会移动你的光标，也不会抢走焦点。',
          window: '窗口模式',
          windowHint: '只向指定窗口投递输入，不动光标',
          foreground: '前台模式',
          foregroundHint: '真实鼠标键盘，会移动光标并抢焦点',
          both: '两者皆可',
          bothHint: '由模型按次选择，默认走窗口模式',
          allowInput: '允许模拟输入',
          allowInputHint: '关掉后只能观察（截图、窗口列表、可访问性树）',
          current: '当前',
          loading: '读取中…',
          failed: '读取状态失败',
          settingsLabel: 'Computer Use',
          chipTitle: '切换 Computer Use 输入模式',
        },
        en: {
          title: 'Computer Use',
          description: 'Choose which channel the model may use on this desktop. Window mode never moves your cursor or steals focus.',
          window: 'Window mode',
          windowHint: 'Post input to a chosen window; cursor stays put',
          foreground: 'Foreground mode',
          foregroundHint: 'Real mouse and keyboard; moves the cursor and takes focus',
          both: 'Either',
          bothHint: 'The model picks per call; window mode by default',
          allowInput: 'Allow simulated input',
          allowInputHint: 'Off means observe only (screenshots, windows, accessibility tree)',
          current: 'Current',
          loading: 'Loading…',
          failed: 'Failed to read state',
          settingsLabel: 'Computer Use',
          chipTitle: 'Switch Computer Use input mode',
        },
      };

      const LANG = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language ?? '') ? 'zh' : 'en';
      const t = (key) => TEXT[LANG][key] ?? key;

      const MODES = [
        { value: 'window', label: () => t('window'), hint: () => t('windowHint') },
        { value: 'foreground', label: () => t('foreground'), hint: () => t('foregroundHint') },
        { value: 'both', label: () => t('both'), hint: () => t('bothHint') },
      ];

      /** 取服务：既支持 ctx.slots 也支持 ctx.get('slots')。 */
      function service(ctx, key) {
        try {
          if (ctx?.[key] !== undefined) return ctx[key];
          if (typeof ctx?.get === 'function') return ctx.get(key);
        } catch {
          // 取不到就当没有
        }
        return undefined;
      }

      async function readState() {
        try {
          const response = await fetch(STATE_PATH, { headers: { accept: 'application/json' } });
          if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
          return { ok: true, value: await response.json() };
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) };
        }
      }

      async function writeState(patch) {
        try {
          const response = await fetch(STATE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(patch),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) return { ok: false, reason: payload?.error ?? `HTTP ${response.status}` };
          return { ok: true, value: payload };
        } catch (error) {
          return { ok: false, reason: String(error?.message ?? error) };
        }
      }

      const styles = {
        page: {
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          color: 'var(--dsw-alias-label-primary)',
          fontSize: '13px',
          lineHeight: '1.5',
        },
        heading: { fontSize: '15px', fontWeight: 600, margin: 0 },
        description: { margin: 0, color: 'var(--dsw-alias-label-secondary)' },
        group: { display: 'flex', flexDirection: 'column', gap: '8px' },
        option: (active) => ({
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          padding: '10px 12px',
          textAlign: 'left',
          borderRadius: '10px',
          cursor: 'pointer',
          border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
          background: active ? 'var(--dsw-alias-bg-layer-2)' : 'var(--dsw-alias-bg-layer-1)',
          color: 'inherit',
          font: 'inherit',
        }),
        optionTitle: { fontWeight: 600 },
        optionHint: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', margin: 0 },
        row: { display: 'flex', alignItems: 'center', gap: '8px' },
        status: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', margin: 0 },
        error: { color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px', margin: 0 },
        chip: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '2px 8px',
          borderRadius: '999px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-secondary)',
          fontSize: '12px',
          cursor: 'pointer',
        },
      };

      /** 两处界面共用的状态读取器。 */
      function createBinding(react) {
        const { useCallback, useEffect, useState } = react;

        return function useMode() {
          const [state, setState] = useState({ mode: 'window', allowInput: true, error: null, loaded: false, busy: false });

          const refresh = useCallback(async () => {
            const result = await readState();
            if (!result.ok) {
              setState((current) => ({ ...current, loaded: true, error: result.reason }));
              return;
            }
            setState((current) => ({
              ...current,
              mode: result.value?.inputMode ?? current.mode,
              allowInput: result.value?.allowInput ?? current.allowInput,
              loaded: true,
              error: null,
            }));
          }, []);

          useEffect(() => {
            void refresh();
          }, [refresh]);

          const update = useCallback(async (patch) => {
            setState((current) => ({ ...current, busy: true }));
            const result = await writeState(patch);
            if (!result.ok) {
              setState((current) => ({ ...current, busy: false, error: result.reason }));
              return;
            }
            setState((current) => ({
              ...current,
              busy: false,
              error: null,
              mode: result.value?.inputMode ?? current.mode,
              allowInput: result.value?.allowInput ?? current.allowInput,
            }));
          }, []);

          return { ...state, update, refresh };
        };
      }

      const inject = ['slots'];

      function apply(ctx) {
        try {
          const react = (() => {
            try {
              return require('react');
            } catch {
              return undefined;
            }
          })();
          if (!react || typeof react.createElement !== 'function') return;

          const slots = service(ctx, 'slots');
          if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return;

          const h = react.createElement;
          const useMode = createBinding(react);

          function SettingsSection() {
            const { mode, allowInput, error, loaded, busy, update } = useMode();
            return h(
              'div',
              { style: styles.page },
              h('h3', { style: styles.heading }, t('title')),
              h('p', { style: styles.description }, t('description')),
              h(
                'div',
                { style: styles.group, role: 'radiogroup', 'aria-label': t('title') },
                ...MODES.map((entry) =>
                  h(
                    'button',
                    {
                      key: entry.value,
                      type: 'button',
                      role: 'radio',
                      'aria-checked': mode === entry.value,
                      disabled: busy,
                      style: styles.option(mode === entry.value),
                      onClick: () => void update({ inputMode: entry.value }),
                    },
                    h('span', { style: styles.optionTitle }, entry.label()),
                    h('span', { style: styles.optionHint }, entry.hint()),
                  ),
                ),
              ),
              h(
                'label',
                { style: styles.row },
                h('input', {
                  type: 'checkbox',
                  checked: allowInput,
                  disabled: busy,
                  onChange: (event) => void update({ allowInput: event.target.checked }),
                }),
                h('span', null, t('allowInput')),
              ),
              h('p', { style: styles.optionHint }, t('allowInputHint')),
              h(
                'p',
                { style: error === null ? styles.status : styles.error },
                error !== null
                  ? `${t('failed')}：${error}`
                  : loaded
                    ? `${t('current')}：${MODES.find((entry) => entry.value === mode)?.label() ?? mode}`
                    : t('loading'),
              ),
            );
          }

          function ComposerChip() {
            const { mode, busy, error, update } = useMode();
            const index = Math.max(0, MODES.findIndex((entry) => entry.value === mode));
            const next = MODES[(index + 1) % MODES.length];
            return h(
              'button',
              {
                type: 'button',
                style: styles.chip,
                disabled: busy,
                title: error === null ? t('chipTitle') : `${t('failed')}：${error}`,
                'aria-label': `${t('chipTitle')} (${t('current')}：${MODES[index].label()})`,
                onClick: () => void update({ inputMode: next.value }),
              },
              h('span', { 'aria-hidden': true }, '🖱'),
              h('span', null, MODES[index].label()),
            );
          }

          slots.inject('settings.section', () =>
            slots.register(
              { name: 'settings.section', id: 'computer-use', order: 63, label: () => t('settingsLabel') },
              SettingsSection,
            ),
          );

          slots.inject('conversation.input.left', () =>
            slots.register(
              { name: 'conversation.input.left', id: 'computer-use-mode', order: 40, label: () => t('settingsLabel') },
              ComposerChip,
            ),
          );
        } catch {
          // 面板挂了也不能拖垮插槽：没有界面时插件其余部分照常工作
        }
      }

      return { inject, apply };
    },
  });
})();
