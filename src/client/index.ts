// client 半侧 bundle 外壳：由 tsdown 构建为 lib/client.js。
// 必须是一个「普通副作用脚本」——加载时调用 window.__ModuleLoader__.load，
// 不能包含顶层 ESM export / import（react 由 factory 的 require 取得）。
//
// 职责：把装配层 app.ts 产出的插件 factory 注册进 DSH 页面的全局模块系统，
//       插件随之被装载运行（宠物 overlay、设置页、系统通知等能力由 apply 注册）。
//
// 与其它模块的关系：
//   - app.ts（makeFactory）：唯一直接依赖，产出「插件三件套」（name/inject/apply）；
//   - 本文件是 client 半侧唯一的对外入口——DSH 网页按 package.json 的
//     exports['./client'] 加载 /plugins/dsh-pet/client.js 时首先执行它；
//   - 与宿主半侧（host/index.ts → lib/index.js）没有直接调用关系，二者各自被
//     DSH 装载（cordis.patch.yml：entry 行 id 'pet'，模块 name 'dsh-pet'）。
//
// 调用时机：DSH 页面加载本 bundle 时同步执行一次（且仅一次）；此后所有生命周期
//   交给 DSH 模块系统——依赖（slots/locale/connection）就绪后调用 factory，
//   再执行 apply 完成插槽注册。
//
// 形态约束补充：源码里的顶层 import 会被 tsdown 内联进产物，因此产物运行时
//   没有任何模块依赖；顶层不能有 export（产物被当作普通脚本执行）。
import { makeFactory } from './app';

// DSH 页面在 window 上注入的全局模块加载器（仅编译期声明，不产出运行时代码）。
// 真实实现由 @deepseek-ai/dsh-client-runtime 在页面初始化时挂载；
// 这里只声明本插件用到的 load() 最小签名。
declare const window: {
  __ModuleLoader__: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DSH 全局注入的模块系统契约（f(require) => module）
    load(info: { id: string; factory: (require: (m: string) => any) => any }): void;
  };
};

// 本文件唯一的模块级副作用：把插件注册进 DSH 模块系统。
// - id 'dsh-pet'：插件包名/模块名，DSH 按它解析与去重（与 cordis.patch.yml 对应：
//   entry 行 id 为 'pet'，模块 name 为 'dsh-pet'）；
// - factory：makeFactory() 现场创建并返回 (require) => module 闭包；
//   DSH 在注入依赖就绪后调用 factory 拿到 module，再执行 apply。
window.__ModuleLoader__.load({
  id: 'dsh-pet',
  factory: makeFactory(),
});
