import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const emptyLoader='// Teyvat-Plugin loads the selected original apps. Original source/resources/licenses remain in this checkout.\nexport const apps = {};\n';

export function planProviderSettings(botRoot,{yaml}={}) {
  botRoot=path.resolve(botRoot);
  if(!fs.existsSync(path.join(botRoot,'lib/plugins/plugin.js')))return {state:'missing',reason:'Yunzai host is absent',writes:[]};
  let YAML=yaml;
  try{YAML=YAML||createRequire(path.join(botRoot,'package.json'))('yaml');}
  catch{return {state:'missing',reason:'Host yaml dependency is absent',writes:[]};}
  const writes=[],skipped=[];
  const add=(file,text)=>{
    const resolved=path.resolve(botRoot,file),relative=path.relative(botRoot,resolved);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Provider path escapes the host');
    writes.push({file:resolved,text});
  };
  const readYaml=(file)=>fs.existsSync(file)?YAML.parse(fs.readFileSync(file,'utf8'))||{}:{};
  for(const directory of ['miao-plugin','genshin','xhh-TL','FanSky_Qs']) {
    const pluginRoot=path.join(botRoot,'plugins',directory);
    if(!fs.existsSync(pluginRoot)){skipped.push(directory);continue;}
    const index=path.join(pluginRoot,'index.js');
    const backup=path.join(pluginRoot,'index.teyvat-original.js.txt');
    if(fs.existsSync(index)&&!fs.existsSync(backup)&&fs.readFileSync(index,'utf8')!==emptyLoader)add(path.relative(botRoot,backup),fs.readFileSync(index,'utf8'));
    add(path.relative(botRoot,index),emptyLoader);
  }
  if(fs.existsSync(path.join(botRoot,'plugins/xhh-TL'))) {
    const defaults=readYaml(path.join(botRoot,'plugins/xhh-TL/config/default_config.yaml'));
    const existing=readYaml(path.join(botRoot,'plugins/xhh-TL/config/config.yaml'));
    const settings={...defaults,...existing,
      reply_quote:true,img_type:'jpeg',Tl:true,render_scale:1.0,
      tl_priority:-999,show_all_bindings:true,tl_render_mode:'merge',tl_uids_per_image:2,tl_cards_per_msg:3,
      waves_tl_enable:false,waves_tl_gsuid_db:'',all_abyss:false,sr_gacha_enable:false,
      role_combat:true,gs_all_abyss:true,abyss_team:true,hard_team:true,hold_rate:true,team_damage:true,
      team_damage_priority:-98,team_damage_timeout:20,nanoka_abyss_enable:true,
      tmp_clean_enable:false,del_ck_hook_enable:false,solver_deploy_enable:false,captcha_notice_enable:false,
      auto_verify_addr:'',auto_sign_verify_addr:'',
      stoken_paths:'plugins/Teyvat-Plugin/data/no-native-credentials',
      bbs_coin_gsuid_db:path.join(botRoot,'plugins/xhh-TL/data/disabled-external-db/GsData.db'),
      resin_push_enable:false,resin_push_cron:'*/10 * * * *',resin_timer_enable:false,
      auto_sign_enable:false,auto_sign_cron:'23 0 * * *',
      bbs_coin_enable:false,bbs_coin_cron:'50 0 * * *',bbs_coin_games:'gs'
    };
    add('plugins/xhh-TL/config/config.yaml',YAML.stringify(settings));
    // No pre-created subscriptions: only users who explicitly enable them
    // will receive reminder/sign-in/community-task messages.
  }
  if(fs.existsSync(path.join(botRoot,'plugins/genshin'))) {
    const defaults=readYaml(path.join(botRoot,'plugins/genshin/defSet/mys/set.yaml'));
    const existing=readYaml(path.join(botRoot,'plugins/genshin/config/mys.set.yaml'));
    add('plugins/genshin/config/mys.set.yaml',YAML.stringify({...defaults,...existing,allowUseCookie:0,abbrSetAuth:2}));
    const pushDefault=readYaml(path.join(botRoot,'plugins/genshin/defSet/mys/pushNews.yaml'));
    const pushCurrent=readYaml(path.join(botRoot,'plugins/genshin/config/mys.pushNews.yaml'));
    const push={...pushDefault,...pushCurrent};
    for(const key of Object.keys(push))if(/(?:Group|Push)$/.test(key)&&!key.startsWith('gs'))push[key]={};
    add('plugins/genshin/config/mys.pushNews.yaml',YAML.stringify(push));
  }
  if(fs.existsSync(path.join(botRoot,'plugins/miao-plugin'))) {
    const cfg=path.join(botRoot,'plugins/miao-plugin/config/cfg.js');
    let source=fs.existsSync(cfg)?fs.readFileSync(cfg,'utf8'):'';
    const changes={profileServer:'222',requestInterval:5,groupRank:true,charPicSe:false,teamCalc:false,proShareProfileImg:false,notReleasedData:false};
    for(const [key,value] of Object.entries(changes)) {
      const definition='export const '+key+' = '+JSON.stringify(value);
      const expression=new RegExp('^export\\s+const\\s+'+key+'\\s*=.*$','m');
      source=expression.test(source)?source.replace(expression,definition):source+'\n'+definition+'\n';
    }
    add('plugins/miao-plugin/config/cfg.js',source);
    add('plugins/miao-plugin/config/profile.js',"export const enkaApi = {url:'https://enka.network/',proxyAgent:''};\nexport const miaoApi = {qq:'',token:''};\nexport const requestInterval = 5;\nexport const profileImgSrc = ['profile'];\n");
  }
  if(fs.existsSync(path.join(botRoot,'plugins/FanSky_Qs'))) {
    const file='plugins/FanSky_Qs/config/TeyvatConfig/TeyvatUrlJson.json';
    if(!fs.existsSync(path.join(botRoot,file)))add(file,JSON.stringify({CHAR_DATA:{},HASH_TRANS:{},CALC_RULES:{},RELIC_APPEND:{}},null,2)+'\n');
    // No StarRunCheckConfig, no proxy rewrite, no Redis global function flags,
    // and no initial resource downloads or private notifications.
  }
  return {state:skipped.length?'partial':'ready',writes,skipped};
}

export function applyProviderSettings(plan) {
  if(!['ready','partial'].includes(plan.state))return {state:plan.state,written:0};
  for(const {file,text} of plan.writes) {
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.teyvat-tmp';
    fs.writeFileSync(temp,text,{mode:0o600});
    fs.renameSync(temp,file);
  }
  return {state:plan.state,written:plan.writes.length,skipped:plan.skipped};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const position=process.argv.indexOf('--bot-root');
  if(position<0||!process.argv[position+1]){console.error('Usage: node scripts/provider-settings.mjs --bot-root /opt/qqbot/yunzai [--apply]');process.exitCode=2;}
  else {
    const plan=planProviderSettings(process.argv[position+1]);
    if(process.argv.includes('--apply'))console.log(JSON.stringify(applyProviderSettings(plan)));
    else console.log(JSON.stringify({state:plan.state,reason:plan.reason,skipped:plan.skipped,files:plan.writes.map(item=>item.file)}));
  }
}
