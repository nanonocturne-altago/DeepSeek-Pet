// ============================================================================
// 余额气泡（client 半侧）：展示当前服务商余额/用量。哑组件——数据由上层传入，
// 自身不发起请求；工厂形态与 pet.ts 一致（react 由 DSH 运行时注入）。
// ============================================================================
//
// DOM 结构：
//   <style data-plugin-css="dsh-pet/bubble"> —— 本模块唯一注入样式（bubbleCss）
//   <div class="dsh-pet-bubble [is-on]">  —— 气泡卡片（React 渲染，挂在宠物 DOM 树内）
//     .pet-bub-row / .pet-bub-sub —— 主行/副行（余额、今日已用、加载中、重置提示）
//     .pet-bub-err               —— 错误行（查询失败等原因，绝不伪造数字）
//
// 与其它模块的关系：
//   - pet.ts：makeBalanceBubble({ h }) 产出 BalanceBubble 组件，作为宠物上方的悬浮气泡
//     渲染；props = { state, on }（state 由 PetMulti 的余额刷新逻辑提供）。
//   - balance.ts：BalanceState 类型、urgentWindow（窗口期判断）、resetInText（重置倒计时）、
//     deepseekPricingTier（峰谷计价档位）均来自这里；本文件只消费、不发起请求。
//   - host 侧：/dsh-pet-7340/font/上首软糖体.ttf 由 host 从 assets/fonts 提供。
//
// 已知坑：
//   - 气泡在宠物 DOM 树内（z-index:3），菜单/弹窗挂在 body（z-index 2147483647）：
//     两层互不遮挡；气泡所有尺寸一律基于 CSS 变量 --dsh-pet-size 等比缩放，勿写死 px。
//   - pointer-events:none：气泡必须穿透鼠标事件，否则会挡住对宠物本身的点击/拖拽。
//   - 样式只注入一次（injectBubbleCss 判空）：工厂可能被多个 PetCard 各调用一次。
//   - state === null 显示「加载中…」；state.ok=false 必须展示真实原因，绝不伪造数字。
// ============================================================================
// 数据侧纯函数/类型（balance.ts）：窗口期判断、重置倒计时文案、峰谷计价档位
import { urgentWindow, resetInText, deepseekPricingTier } from './balance';
import type { BalanceState } from './balance';
// React 类型（DSH 运行时注入 react）：组件返回 ReactNode，h = jsx 工厂
import type { ReactNode } from 'react';
import type { jsx } from 'react/jsx-runtime';

/** 气泡内联样式：白色半透明圆润泡 + 底部小尾巴指向宠物；字体用上首软糖体（本地打包，稳定）。
 * 所有尺寸基于 `--dsh-pet-size`（宠物宽度 px）等比缩放——宠物放大/缩小，气泡跟随。
 * 系数按默认 462px 设计：21px 字号 → ×0.0455、120px 最小宽 → 0.26、230px 最大宽 → 0.5 等。
 * 层叠规则：z-index:3 仅作用于宠物 DOM 树内（菜单/弹窗在 body 上 2147483647，互不影响）；
 * pointer-events:none 让气泡完全穿透鼠标事件；opacity + .is-on 控制显隐过渡。 */
const bubbleCss = [
  // 本地字体：/dsh-pet-7340/font/ 由 host 从 assets/fonts 提供；font-display swap 先回退后切换
  '@font-face{font-family:"ShangshouSoftCandy";src:url("/dsh-pet-7340/font/上首软糖体.ttf") format("truetype");font-display:swap;font-weight:400}',
  '.dsh-pet-bubble{position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(100% - var(--dsh-pet-size)*0.108);' +
    'min-width:calc(var(--dsh-pet-size)*0.26);max-width:calc(var(--dsh-pet-size)*0.5);' +
    'padding:calc(var(--dsh-pet-size)*0.022) calc(var(--dsh-pet-size)*0.030);' +
    'border-radius:calc(var(--dsh-pet-size)*0.035);' +
    'background:rgba(255,255,255,.92);' +
    'color:#2b2b2b;font-family:"ShangshouSoftCandy","Yuanti SC","YouYuan","幼圆","Comic Sans MS","PingFang SC","Microsoft YaHei",sans-serif;' +
    'font-size:calc(var(--dsh-pet-size)*0.0455);line-height:1.6;z-index:3;pointer-events:none;' +
    'box-shadow:0 calc(var(--dsh-pet-size)*0.009) calc(var(--dsh-pet-size)*0.035) rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.08);' +
    'backdrop-filter:blur(6px);opacity:0;transition:opacity .25s ease;white-space:nowrap}',
  // 底部尾巴：小三角指向下方宠物（同样随宠物缩放）
  '.dsh-pet-bubble::after{content:"";position:absolute;left:50%;bottom:calc(var(--dsh-pet-size)*-0.017);' +
    'transform:translateX(-50%);border:calc(var(--dsh-pet-size)*0.017) solid transparent;' +
    'border-top-color:rgba(255,255,255,.92);border-bottom:none}',
  '.dsh-pet-bubble.is-on{opacity:1}',
  '.dsh-pet-bubble .pet-bub-title{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6);margin-bottom:calc(var(--dsh-pet-size)*0.009)}',
  '.dsh-pet-bubble .pet-bub-row{display:flex;justify-content:space-between;gap:calc(var(--dsh-pet-size)*0.030)}',
  '.dsh-pet-bubble .pet-bub-sub{font-size:calc(var(--dsh-pet-size)*0.035);color:rgba(43,43,43,.6)}',
  '.dsh-pet-bubble .pet-bub-val{font-variant-numeric:tabular-nums;font-weight:650;color:#1f1f1f}',
  '.dsh-pet-bubble .pet-bub-err{color:#d94f3d;font-size:calc(var(--dsh-pet-size)*0.035)}',
  '.dsh-pet-bubble .pet-bub-tag{margin-left:calc(var(--dsh-pet-size)*0.013);font-size:calc(var(--dsh-pet-size)*0.022);color:rgba(43,43,43,.55);border:1px solid rgba(43,43,43,.25);' +
    'border-radius:calc(var(--dsh-pet-size)*0.013);padding:0 calc(var(--dsh-pet-size)*0.009);vertical-align:1px}',
  // 峰/谷计价档位标注：峰红、谷绿
  '.dsh-pet-bubble .pet-bub-tier{font-weight:700}',
  '.dsh-pet-bubble .pet-bub-tier-peak{color:#e53935}',
  '.dsh-pet-bubble .pet-bub-tier-idle{color:#2e9e4f}',
].join('\n');

/**
 * 只注入一次（幂等）：<head> 中已存在 data-plugin-css="dsh-pet/bubble" 则跳过。
 * @副作用 document.head 追加一个 <style>（仅首次）
 */
function injectBubbleCss(): void {
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-pet/bubble"]') === null) {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-pet';
    tag.dataset.pluginCss = 'dsh-pet/bubble';
    tag.textContent = bubbleCss;
    document.head.appendChild(tag);
  }
}

/**
 * 制造余额气泡（工厂）。
 * 工厂内注入样式一次（与 pet.ts 的 injectCss 同模式）；组件为哑组件，props = { state, on }。
 * @param rt DSH 运行时注入的 React 句柄（h = jsx 工厂，与 pet.ts 同模式）
 * @returns React 组件 BalanceBubble：state = 余额数据（null = 加载中），on = 是否显示（淡入淡出）
 * @副作用 首次调用时注入一次样式（injectBubbleCss）
 */
export function makeBalanceBubble(rt: {
  h: typeof jsx;
}): (props: { state: BalanceState | null; on: boolean }) => ReactNode {
  const { h } = rt;
  injectBubbleCss();

  // 实际渲染的哑组件：三态分支 —— null=加载中 / ok=按 kind（opencode/DeepSeek）渲染 / 失败=展示原因
  return function BalanceBubble({ state, on }: { state: BalanceState | null; on: boolean }) {
    const rows: ReactNode[] = [];
    if (state === null) {
      // 点击宠物手动刷新时余额尚未返回：显示加载中（移植自插件 A 的「加载中…」状态）
      rows.push(h('div', { className: 'pet-bub-row pet-bub-sub', children: '加载中…' }));
    } else if (state.ok) {
      if (state.kind === 'opencode') {
        // 联想框两行：第一行「周额度已用 88%」，第二行「2.5 天重置」
        const w = urgentWindow(state);
        if (w) {
          const reset = resetInText(w.resetsAt);
          rows.push(
            h('div', { className: 'pet-bub-row', children: w.label + '额度已用 ' + Math.round(w.percent) + '%' }),
          );
          rows.push(h('div', { className: 'pet-bub-row pet-bub-sub', children: reset ? reset + '重置' : '已重置' }));
        } else {
          rows.push(h('div', { className: 'pet-bub-row', children: '额度数据不可用' }));
        }
      } else {
        // DeepSeek：单行「余额（峰/谷）¥x.xx」——按北京时间峰谷价档上色（峰红/谷绿）
        const tier = deepseekPricingTier();
        rows.push(
          h('div', {
            className: 'pet-bub-row',
            children: h('span', {
              children: [
                '余额（',
                h('span', {
                  className: 'pet-bub-tier pet-bub-tier-' + tier,
                  children: tier === 'peak' ? '峰' : '谷',
                }),
                '）¥' + (state.total ?? '-'),
              ],
            }),
          }),
        );
        // 今日已用（移植自插件 A：ledger 记账 / token 峰谷定价的金额，随气泡一起显示）
        const todayUsage = state.usage?.todayUsage;
        if (typeof todayUsage === 'number' && Number.isFinite(todayUsage)) {
          rows.push(h('div', { className: 'pet-bub-row pet-bub-sub', children: '今日已用 ¥' + todayUsage.toFixed(2) }));
        }
      }
    } else {
      // 显式展示不可用原因，绝不伪造数字
      const msg =
        state.reason === 'unsupported'
          ? '当前服务商暂不支持余额查询'
          : state.reason === 'credential-missing'
            ? '缺少凭证：' + (state.message ?? '')
            : '余额查询失败';
      rows.push(h('div', { className: 'pet-bub-err', children: msg }));
    }

    // 统一外层：.dsh-pet-bubble 基类 + .is-on 控制显隐（opacity 过渡由 CSS 完成）
    return h('div', {
      className: 'dsh-pet-bubble' + (on ? ' is-on' : ''),
      children: rows,
    });
  };
}
