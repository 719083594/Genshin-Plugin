export const helpTopics={
 'genshin-login':{title:'原神 · 账号授权',subtitle:'国服优先 · 每个使用者单独授权',groups:[
  {title:'米游社扫码',items:[{command:'1. 私聊 #原神登录 [可选UID]',description:'用米游社 APP 扫一扫，在官方页面确认。不要转发二维码。'},{command:'2. 等待确认，或发送 #原神扫码状态',description:'验证本人角色归属后，账号凭据以 AES 加密保存。'},{command:'3. #原神便笺 / #原神深渊',description:'授权后即可查询；若官方要求安全验证，请按 bot 提示操作。'}]},
  {title:'多个账号',items:[{command:'#原神账户',description:'查看本人的绑定'},{command:'#原神切换 UID',description:'切换自己的查询账号'},{command:'#原神解绑 UID',description:'删除本 bot 保存的授权与绑定'}]},
  {title:'公开查询',items:[{command:'#原神绑定 UID / #原神展柜 UID',description:'只绑定 UID 可查看公开展柜，不能代替本人授权。'}]},
 ],footer:'登录和凭据操作仅私聊。不要发送密码；每个 QQ 用户的账号独立加密保存。'},
 'genshin-features':{title:'原神 · 功能说明',subtitle:'独立核心与原生扩展',groups:[
  {title:'账户与个人记录',items:[{command:'米游社扫码 / 多账号切换 / 安全验证',description:'账户隔离，AES 加密保存授权'},{command:'便笺 / 深渊 / 剧诗 / 危战 / 角色资料',description:'查询官方返回的本人数据'},{command:'米游币 / 米游币任务',description:'仅只读查询，不执行签到、点赞、分享或兑换'}]},
  {title:'资料与记录',items:[{command:'公开展柜 / 角色 / 武器 / 圣遗物 / 材料',description:'角色资料与公开展示'},{command:'正式版 / 预下载 / 历史包体',description:'原神资源信息'},{command:'UIGF 导入 / 导出 / 分析',description:'私人祈愿记录仅本人私聊'}]},
  {title:'扩展与订阅',items:[{command:'树脂提醒 / 版本推送',description:'用户自行订阅，启用状态可查'},{command:'面板 / 伤害模拟 / 配队 / 榜单',description:'由已加载的外部原神模块提供'},{command:'墨安原神协议',description:'需管理员配置可用 HTTPS 服务及本人 Key'}]},
 ],footer:'发送 #原神帮助 查看指令，#原神状态 查看实际加载状态。外部服务可用性由对应服务决定。'},
};
