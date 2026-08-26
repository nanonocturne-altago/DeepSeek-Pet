// client 半侧「装配层」：注入 react → 组装两个页面组件 → 注册进 DSH 插槽。
// 页面代码不在本文件：宠物页面在 pet.ts，设置页在 settings.ts——
// 类似 Vue 的 App.vue 只挂根组件、SpringBoot 启动类只做装配，不写页面业务。
//
// 职责（全部装配逻辑，无页面业务）：
//   1. 通过 require 从 DSH 运行时取得 react 与 jsx-runtime（client 半侧不能顶层
//      import react，需与宿主共享同一 react 实例）；
//   2. 调用 pet.ts / settings.ts 的组件工厂函数制造页面组件；
//   3. 注册三个运行时行为：本地化字典、系统通知引擎、宠物 overlay 浮层；
//   4. 注册设置页区块「桌宠配置」。
//
// 与其它模块的关系：
//   - index.ts（客户端入口）：调用本文件的 makeFactory 并把 factory 交给 DSH 模块系统；
//   - pet.ts / settings.ts：提供页面组件工厂（makePetUI / makePetConfigSection）；
//   - notify.ts：提供 startNotify（系统通知引擎，由本层装配启动）；
//   - 被 DSH 模块系统调用：注入依赖（slots/locale/connection）就绪后执行 apply。
//
// 调用时机：每个 DSH 页面会话装载本插件时执行一次 factory（由 index.ts 触发），
//   之后插件常驻直至页面刷新/卸载。
import { makePetUI } from './pet';
import { makePetConfigSection, NS, zh, en } from './settings';
import { startNotify } from './notify';
import type * as ReactNS from 'react';

/**
 * 返回 DSH 插件 factory：`(require) => module`。
 * 插件三件套（name / inject / apply）都在其返回的 module 上。
 */
// @param require DSH 模块系统提供的同步 require（CommonJS 风格），用于取 react 等宿主能力
// @returns 插件 module（{ name, inject, apply }）；DSH 按 inject 声明注入依赖后调用 apply
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH __ModuleLoader__ 契约（f(require) => module），外部无静态类型
export function makeFactory(): (require: (mod: string) => any) => any {
  return (require) => {
    // CommonJS 风格的 module 容器：先建好 exports，最后挂上插件三件套再返回
    const module = { exports: {} };

    // react 能力全部来自 DSH 运行时注入（与宿主共享同一 react 实例，避免重复打包），
    // 只解构本插件用到的 hooks + jsx 工厂（组件用 h() 手写元素，无 JSX 编译）
    const react: typeof ReactNS = require('react');
    const { useEffect, useRef, useState } = react;
    const { jsx: h } = require('react/jsx-runtime');

    // 宠物页面（overlay）与配置设置页：组件各自独立文件，这里只组装 + 注册
    const PetMulti = makePetUI({ h, useState, useEffect, useRef });

    // 插件名（'pet'）：与 cordis.patch.yml 的插件行 id、宿主半侧 host/index.ts 的 name 一致
    const name = 'pet';
    // 需要 DSH 注入的服务：slots（插槽注册）、locale（本地化）、connection（事件流/API）
    const inject = ['slots', 'locale', 'connection'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 注入的 ctx（locale/slots/webServer 等 service 无静态类型）
    function apply(ctx: any) {
      // 本地化字典（设置页文案）
      // 注册 zh/en 两种语言；t 即绑定本插件的翻译函数
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-pet: dictionaries');
      const t = ctx.locale.bind(NS);

      // 系统通知：订阅 DSH 事件流（对话完成/生成失败/权限申请/用户选择），窗口失焦时弹出
      // effect 返回清理函数：插件卸载/重载时 abort，通知引擎的两条事件流随之退出
      ctx.effect(() => {
        const api = ctx.connection?.api;
        // 防御：connection 服务缺失（宿主版本不支持）时跳过通知功能，不影响宠物本体
        if (api && typeof api?.events?.mux === 'function' && typeof api?.events?.host === 'function') {
          const ac = new AbortController();
          void startNotify(api, ac.signal);
          return () => ac.abort();
        }
        console.warn('[dsh-pet] 系统通知未启动：connection 服务不可用');
        return () => {};
      }, 'dsh-pet: notifications');

      // 宠物 overlay（多开：容器渲染多个 PetCard）
      // generator 注入：yield 的 register 结果即插槽生命周期句柄，卸载时由 DSH 自动清理
      ctx.slots.inject('shell.overlay', function* () {
        yield ctx.slots.register({ name: 'shell.overlay', id: 'pet', order: 1000 }, () => h(PetMulti, {}));
      });

      // 设置页：「桌宠配置」（大小/位置，保存即时生效）
      // 组件工厂需要 react 能力 + t（翻译函数）；注册时通过 inject 把 t 注入组件 props
      const PetConfigSection = makePetConfigSection({ h, useState, useEffect, t });
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register(
          { name: 'settings.section', id: 'pet-config', order: 30, label: () => t('nav'), inject: () => ({ t }) },
          PetConfigSection,
        );
      });
    }

    // 插件三件套挂到 exports 上，返回给 DSH 模块系统
    module.exports = { apply, inject, name };
    return module.exports;
  };
}
