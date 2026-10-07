import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {JsonHttp} from './http.mjs';import {atomic} from './config.mjs';import {validateUid} from './accounts.mjs';
export function uid(value){return validateUid(value).uid}
export class PublicData{
  constructor(root,options={}){this.root=root;this.http=new JsonHttp(options);this.cache=new Map();this.cacheMs=(options.cacheSeconds||300)*1000;this.pending=new Map()}
  async cached(key,load){const old=this.cache.get(key);if(old&&old.expires>Date.now())return structuredClone(old.data);if(this.pending.has(key))return this.pending.get(key);const promise=Promise.resolve().then(load).then(data=>{this.cache.set(key,{data,expires:Date.now()+this.cacheMs});return structuredClone(data)}).finally(()=>this.pending.delete(key));this.pending.set(key,promise);return promise}
  showcase(id){id=uid(id);return this.cached('showcase:'+id,()=>this.http.get('https://enka.network/api/uid/'+id+'/'))}
  async version(){return this.cached('version',async()=>{const data=await this.http.get('https://hyp-api.mihoyo.com/hyp/hyp-connect/api/getGameBranches?launcher_id=jGHBHlcOq1&game_ids[]=1Z8W5NHUQb');if(data.retcode!==0||!data.data?.game_branches?.length)throw new Error('启动器未返回原神版本');const g=data.data.game_branches.find(x=>x.game?.id==='1Z8W5NHUQb')||data.data.game_branches[0];const row={time:new Date().toISOString(),current:g.main?.tag||'',preDownload:g.pre_download?.tag||''};const file=path.join(this.root,'data/versions.json');let rows=[];try{rows=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}if(!rows.length||rows.at(-1).current!==row.current||rows.at(-1).preDownload!==row.preDownload){rows.push(row);atomic(file,rows.slice(-200))}return row})}
  versionHistory(){try{return JSON.parse(fs.readFileSync(path.join(this.root,'data/versions.json'),'utf8'))}catch{return []}}
  /** Credential-free CN PC metadata. Archive URLs can lag the current Sophon branch. */
  packages(type='main'){type=packageType(type);return this.cached('packages:'+type,async()=>{
    const branches=await this.http.get(BRANCHES_URL);
    const game=officialGame(branches,'game_branches');
    const branch=type==='pre'?game.pre_download:game.main;
    const time=new Date().toISOString();
    if(!branch?.tag||!branch.package_id){const row={time,type,region:'cn',platform:'pc',available:false,version:'',languages:['zh-cn'],full:null,updates:[],archives:null,warnings:[type==='pre'?'官方当前未开放预下载':'官方当前未提供正式资源分支']};this.observePackages(row);return row}
    const query=new URLSearchParams({branch:type==='pre'?'predownload':'main',plat_app:'ddxf5qt290cg',package_id:String(branch.package_id),password:String(branch.password||'')});
    const baseVersions=[...new Set((branch.diff_tags||[]).filter(x=>typeof x==='string'&&x))];
    const [fullResult,patchResult,archiveResult]=await Promise.allSettled([
      this.packageJson('getBuild',query,'GET'),
      baseVersions.length?this.packageJson('getPatchBuild',query,'POST'):Promise.resolve(null),
      this.http.get(PACKAGES_URL)
    ]);
    if(fullResult.status==='rejected')throw fullResult.reason;
    const build=officialBuild(fullResult.value,branch.tag);
    const resources=build.manifests.map(x=>manifestResource(x));
    if(!resources.some(x=>x.category==='game'))throw new Error('官方资源清单没有游戏本体');
    const warnings=[];
    const full={...resourceTotals(resources),resources};
    if(!resources.some(x=>x.category==='zh-cn'))warnings.push('清单未单列中文语音包，不能确认其单独体积');
    let updates=[];
    if(patchResult.status==='fulfilled'&&patchResult.value){try{const patch=officialBuild(patchResult.value,branch.tag);updates=baseVersions.map(fromVersion=>{const items=patch.manifests.map(x=>manifestResource(x,fromVersion));return {fromVersion,...resourceTotals(items),resources:items}})}catch{warnings.push('当前增量资源清单不可用')}}
    else if(patchResult.status==='rejected')warnings.push('当前增量资源清单连接失败');
    let archives=null;
    if(archiveResult.status==='fulfilled'){try{const legacy=officialGame(archiveResult.value,'game_packages');archives=archiveMetadata(type==='pre'?legacy.pre_download:legacy.main,branch.tag);if(archives&&!archives.current)warnings.push('传统ZIP接口版本落后于当前分支；旧链接仅供对应旧版本参考')}catch{warnings.push('传统ZIP元数据不可用')}}
    else warnings.push('传统ZIP元数据连接失败');
    const row={time,type,region:'cn',platform:'pc',available:true,version:String(branch.tag),languages:['zh-cn'],full,updates,archives,warnings};
    this.observePackages(row);return row
  })}
  async packageJson(kind,query,method){
    if(!['getBuild','getPatchBuild'].includes(kind)||method!==(kind==='getPatchBuild'?'POST':'GET'))throw new Error('未授权的安装包接口');
    let response;try{response=await this.http.fetch(SOPHON_URL+kind+'?'+query,{method,redirect:'error',signal:AbortSignal.timeout(this.http.timeoutMs),headers:{'User-Agent':'Genshin-Plugin/0.1.0'}})}catch{throw new Error('安装包数据接口连接失败或超时')}
    if(!response.ok)throw new Error('安装包数据接口 HTTP '+response.status);
    if(Number(response.headers?.get?.('content-length')||0)>8*1024*1024)throw new Error('安装包响应过大');
    const raw=await response.text();if(Buffer.byteLength(raw)>8*1024*1024)throw new Error('安装包响应过大');
    try{return JSON.parse(raw)}catch{throw new Error('安装包接口未返回JSON')}
  }
  observePackages(row){
    // Observation history contains sizes and digests only, never URLs or launcher passwords.
    const identity={type:row.type,available:row.available,version:row.version,full:row.full,updates:row.updates,archives:row.archives};
    const fingerprint=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const rows=this.packageHistory();const prior=[...rows].reverse().find(x=>x.type===row.type);
    if(prior?.fingerprint===fingerprint)return;
    const summary={time:row.time,type:row.type,region:'cn',platform:'pc',available:row.available,version:row.version,languages:row.languages,full:row.full?{downloadBytes:row.full.downloadBytes,resourceBytes:row.full.resourceBytes}:null,updates:row.updates.map(({fromVersion,downloadBytes,resourceBytes})=>({fromVersion,downloadBytes,resourceBytes})),archiveVersion:row.archives?.version||'',archivesCurrent:row.archives?.current??false,fingerprint};
    atomic(path.join(this.root,'data/packages.json'),[...rows,summary].slice(-200));
  }
  packageHistory(type){if(type!==undefined)type=packageType(type);try{const rows=JSON.parse(fs.readFileSync(path.join(this.root,'data/packages.json'),'utf8'));return Array.isArray(rows)?rows.filter(x=>x&&typeof x==='object'&&(type===undefined||x.type===type)):[]}catch{return []}}
  wiki(kind,search){const file=new URL('../resources/catalog.json',import.meta.url);if(!fs.existsSync(file))throw new Error('资料包未安装');const rows=JSON.parse(fs.readFileSync(file,'utf8'))[kind]||[];const q=String(search||'').trim();if(!q)return rows;const exact=rows.filter(x=>x.name===q||String(x.id)===q);return exact.length?exact:rows.filter(x=>x.name.includes(q))}
}
const BRANCHES_URL='https://hyp-api.mihoyo.com/hyp/hyp-connect/api/getGameBranches?launcher_id=jGHBHlcOq1&game_ids[]=1Z8W5NHUQb';
const PACKAGES_URL='https://hyp-api.mihoyo.com/hyp/hyp-connect/api/getGamePackages?launcher_id=jGHBHlcOq1&game_ids[]=1Z8W5NHUQb';
const SOPHON_URL='https://api-takumi.mihoyo.com/downloader/sophon_chunk/api/';
const AUDIO_LANGUAGES=new Set(['zh-cn','en-us','ja-jp','ko-kr']);
function packageType(value){if(!['main','pre'].includes(value))throw new Error('安装包类型必须为 main 或 pre');return value}
function officialGame(body,key){const game=body?.data?.[key]?.find?.(x=>x.game?.id==='1Z8W5NHUQb'&&(!x.game.biz||x.game.biz==='hk4e_cn'));if(body?.retcode!==0||!game)throw new Error('启动器未返回国服原神安装包元数据');return game}
function officialBuild(body,version){if(body?.retcode!==0||!Array.isArray(body.data?.manifests))throw new Error('官方未返回资源清单');if(body.data.tag!==version)throw new Error('官方分支与资源清单版本不一致，请稍后重试');return body.data}
function bytes(value){if(value===null||value===undefined||value==='')return null;const number=Number(value);if(!Number.isSafeInteger(number)||number<0)throw new Error('官方包体字节数不合法');return number}
function officialDownloadUrl(value){if(!value)return '';try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password&&['autopatchcn.yuanshen.com','autopatchcn.mihoyo.com'].includes(u.hostname))return u.href}catch{}return ''}
function manifestResource(manifest,fromVersion){
  const stats=fromVersion?manifest.stats?.[fromVersion]:(manifest.deduplicated_stats||manifest.stats);
  const prefix=officialDownloadUrl(manifest.manifest_download?.url_prefix);
  const id=String(manifest.manifest?.id||'');
  const url=prefix&&/^[a-zA-Z0-9_-]+$/.test(id)?officialDownloadUrl(prefix.replace(/\/$/,'')+'/'+id+(manifest.manifest_download?.url_suffix||'')):'';
  return {category:String(manifest.matching_field||''),downloadBytes:bytes(stats?.compressed_size),resourceBytes:bytes(stats?.uncompressed_size),manifest:{id,checksum:String(manifest.manifest?.checksum||''),url},chunkUrlPrefix:officialDownloadUrl(manifest.chunk_download?.url_prefix||manifest.diff_download?.url_prefix)}
}
function resourceTotals(resources){const selected=resources.filter(x=>x.category==='game'||x.category==='zh-cn');const sum=key=>selected.length&&selected.some(x=>x.category==='game')&&selected.every(x=>x[key]!==null)?selected.reduce((n,x)=>n+x[key],0):null;const downloadBytes=sum('downloadBytes'),resourceBytes=sum('resourceBytes');if([downloadBytes,resourceBytes].some(x=>x!==null&&!Number.isSafeInteger(x)))throw new Error('官方包体总字节数不合法');return {downloadBytes,resourceBytes}}
function archivePackages(items){return (Array.isArray(items)?items:[]).map(x=>({language:x.language||'',url:officialDownloadUrl(x.url),md5:String(x.md5||''),downloadBytes:bytes(x.size),resourceBytes:bytes(x.decompressed_size)})).filter(x=>x.url)}
function archiveMetadata(section,currentVersion){if(!section?.major?.version)return null;const major=section.major;return {version:String(major.version),current:major.version===currentVersion,game:archivePackages(major.game_pkgs),audio:archivePackages(major.audio_pkgs),patches:(section.patches||[]).map(x=>({fromVersion:String(x.version||''),game:archivePackages(x.game_pkgs),audio:archivePackages(x.audio_pkgs)}))}}
export function formatBytes(value){if(value===null||value===undefined)return '未知';let size=value,index=0;const units=['B','KiB','MiB','GiB','TiB'];while(size>=1024&&index<units.length-1){size/=1024;index++}return `${size.toFixed(2)} ${units[index]}`}
export function formatPackages(data){
  const label=data.type==='pre'?'预下载':'正式版';
  if(!data.available)return `原神国服 PC ${label}：官方当前没有可用资源分支。`;
  const lines=[`原神国服 PC ${label} ${data.version}`,'默认体积：游戏本体 + 中文语音',`全量下载估算 ${formatBytes(data.full.downloadBytes)} · 去重资源体积 ${formatBytes(data.full.resourceBytes)}`];
  for(const patch of data.updates)lines.push(`${patch.fromVersion} → ${data.version}：增量下载 ${formatBytes(patch.downloadBytes)} · 增量资源 ${formatBytes(patch.resourceBytes)}`);
  lines.push('Sophon 为分块资源；清单链接不是可直接安装的 ZIP。资源体积不等于最终磁盘占用或临时空间需求。');
  for(const item of data.full.resources.filter(x=>x.category==='game'||x.category==='zh-cn'))if(item.manifest.url)lines.push(`${item.category==='game'?'游戏本体':'中文语音'}清单：${item.manifest.url}`);
  if(data.archives){lines.push(`传统 ZIP ${data.archives.version}${data.archives.current?'':'（旧版本，非当前版本）'}`);for(const item of [...data.archives.game,...data.archives.audio.filter(x=>x.language==='zh-cn')])lines.push(item.url)}
  lines.push(...data.warnings,'来源：米哈游 HoYoPlay / Sophon；历史仅记录本机观察到的变化。');return lines.join('\n')
}
export function formatShowcase(data){const p=data.playerInfo;if(!p)throw new Error('展柜数据不可用');let lines=[`${p.nickname||'旅行者'} · 冒险等级 ${p.level??'?'} · 世界等级 ${p.worldLevel??'?'}`,p.signature||'',`成就 ${p.finishAchievementNum??'?'} · 深渊 ${p.towerFloorIndex??'?'}-${p.towerLevelIndex??'?'}`];for(const a of data.avatarInfoList||[]){const f=a.fightPropMap||{};lines.push(`角色 ${a.avatarId} · Lv.${a.propMap?.['4001']?.val??'?'} · 命座 ${a.talentIdList?.length||0}`,`生命 ${Math.round(f['2000']||0)} · 攻击 ${Math.round(f['2001']||0)} · 防御 ${Math.round(f['2002']||0)}`,`暴击 ${((f['20']||0)*100).toFixed(1)}% · 暴伤 ${((f['22']||0)*100).toFixed(1)}% · 充能 ${((f['23']||0)*100).toFixed(1)}%`)}if(!data.avatarInfoList?.length)lines.push('未公开角色详情；请在游戏角色展柜开启“显示角色详情”。');lines.push('来源：Enka.Network；仅反映公开展柜。');return lines.filter(Boolean).join('\n')}
export function cleanText(v){return String(v??'').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&')}
export function formatWiki(rows){return rows.slice(0,8).map(x=>[`${x.name}${x.star?' · '+x.star+'星':''} · ${x.elem||x.type||''}`,cleanText(x.desc),x.attr?'90级基础攻击：'+Math.round(x.attr.atk?.['90']||0)+'；副属性 '+x.attr.bonusKey+' '+Number(x.attr.bonusData?.['90']||0).toFixed(2)+'%':'',x.affixData?[x.affixTitle,...[0,4].map(rank=>'精炼'+(rank+1)+'：'+cleanText(x.affixData.text).replace(/\$\[(\d+)\]/g,(m,i)=>x.affixData.datas?.[i]?.[rank]??m))].join('\n'):'',x.materials?'养成材料：'+Object.values(x.materials).join('、'):'',...(x.skills||[]).map(s=>s.name+'：'+cleanText(s.desc))].filter(Boolean).join('\n')).join('\n\n')||'没有找到该条目；可用中文名或ID查询。'}
