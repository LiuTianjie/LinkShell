# iOS 实时活动

实时活动展示当前电脑的会话与终端摘要，数据由 `session-attention.ts` 聚合，`LinkLayoutModule.swift` 调用 ActivityKit，`with-live-activity.js` 生成 Widget 扩展。测试输入由 `live-activity-scenarios.test.ts` 从同一聚合函数导出。

## 当前展示

| 场景 | 展示 |
| --- | --- |
| 思考、执行工具、回复 | 绿色「正在运行」，副标题分别显示当前活动 |
| 等待权限确认 | 黄色「等待确认」，显示授权请求标题 |
| 等待问题回答 | 黄色「等待回答」，显示问题标题 |
| 执行出错 | 红色「执行出错」，显示错误摘要 |
| 多任务 | 优先展示等待处理的会话，其次错误，再次运行；展开时显示运行与待处理数量 |
| 终端命令 | 终端图标与命令，计入运行数 |
| 连接断开或内容过期 | 灰色「状态已过期」／「待刷新」，提示打开 App 刷新，不继续显示旧的执行动作和运行数量 |
| 全部完成、只有未启动或离线会话 | 立即结束活动，不保留一张「已完成」卡片 |

锁屏卡片、灵动岛展开、紧凑和最小样式都读取统一的展示状态。系统的 `ActivityViewContext.isStale` 会覆盖缓存的 phase，因此即使 App 已被挂起，也不会把过期内容继续画成绿色运行状态。

## 后台边界

当前 `Activity.request(..., pushType: nil)` 仅接受 App 本地更新，没有接入 ActivityKit APNs 推送。短时间切后台仍可能收到 WebSocket 更新；App 被系统挂起以后，不能保证连接与实时活动持续更新。卡片仍在不证明电脑连接仍在线。

每次本地更新设置两分钟后的 `staleDate`。前台每分钟刷新一次，避免没有新事件的正常会话过期；后台不使用定时器延长缓存有效期。两分钟从最后一次实际更新计算，不是从切后台固定计时。回到前台会刷新连接并恢复会话订阅，期间可能短暂显示离线、随后补齐消息。

这项修复保证过期提示，不提供后台永久保活。要在 App 被挂起后持续更新，需要另行接入 [ActivityKit 推送](https://developer.apple.com/documentation/ActivityKit/starting-and-updating-live-activities-with-activitykit-push-notifications)，并设计状态摘要的传输和隐私边界；不能让现有端到端加密网关直接读取会话明文。

## 验证与交付

- 聚合测试覆盖 14 组输入；刷新测试覆盖前台无新事件、后台停止延长有效期、回到前台和卸载清理。
- iPhone 17 Pro / iOS 26.5 模拟器使用生产 Widget 源码及原生 ActivityKit 更新方法，输入是隔离测试数据。这证明系统中的展示效果，不等同于完整 App 的远程链路或真机长时间后台验证。
- Widget 源码和原生方法的变更需要新的 iOS 二进制；CLI 更新或 Metro 重载不能更新已安装的 Widget。
- Codex 空表单授权和停止修复已在 Host 0.4.35 / CLI 0.10.37 交付，与上述 iOS 展示修复独立。
