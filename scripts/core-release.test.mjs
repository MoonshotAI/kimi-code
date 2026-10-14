import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./core-release.mjs', import.meta.url));
const versionScript = fileURLToPath(new URL('./version-release.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const branch = 'release/test';
const cli = { name: '@moonshot-ai/kimi-code', version: '1.1.0', path: 'apps/kimi-code', private: false };
const sdk = { name: '@example/sdk', version: '0.2.0', path: 'packages/sdk', private: false };
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
const dirs = [];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(packages = [cli]) {
  const dir = mkdtempSync(join(tmpdir(), 'core-release-'));
  dirs.push(dir);
  mkdirSync(join(dir, '.changeset'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'remote'));
  for (const pkg of packages) {
    mkdirSync(join(dir, pkg.path), { recursive: true });
    writeFileSync(join(dir, pkg.path, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(dir, pkg.path, 'CHANGELOG.md'), `# Changelog\n\n## ${pkg.version}\n\nA change.\n`);
  }
  writeFileSync(join(dir, '.changeset/release-plan.json'), JSON.stringify({ branch, packages, changesets: ['fix.md'] }));
  writeFileSync(join(dir, '.changeset/README.md'), '# Changesets');
  const file = join(dir, 'remote/state.json');
  writeFileSync(file, JSON.stringify({ tags: {}, releases: {}, npm: {}, latest: {}, calls: [] }));
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const state = JSON.parse(fs.readFileSync(process.env.TEST_STATE));
const args = process.argv.slice(2);
const exe = path.basename(process.argv[1]);
state.calls.push([exe, ...args]);
const save = () => fs.writeFileSync(process.env.TEST_STATE, JSON.stringify(state));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const value = flag => args[args.indexOf(flag) + 1];
function done(data = {}) { save(); console.log(JSON.stringify(data)); process.exit(0); }
function missing() { save(); console.error('(HTTP 404)'); process.exit(1); }
if (state.error) { save(); console.error('Forbidden'); process.exit(1); }
if (exe === 'gh') {
 if (args[0] === 'api') {
  const endpoint = args[1];
  if (endpoint.includes('/actions/workflows/')) done({workflow_runs: [{id: 1, head_sha: '${sha}', head_branch: '${branch}', event: 'push', status: 'completed', conclusion: state.ci ?? 'success'}]});
  if (endpoint.includes('/git/ref/tags/')) { const tag = decodeURIComponent(endpoint.split('/git/ref/tags/')[1]); if (!state.tags[tag]) missing(); done({object: {type:'commit',sha:state.tags[tag]}}); }
  if (endpoint.endsWith('/git/refs')) { state.tags[args.find(a=>a.startsWith('ref=')).slice(14)] = args.find(a=>a.startsWith('sha=')).slice(4); done(); }
  if (endpoint.includes('/releases/') && !endpoint.includes('/tags/')) {const r=Object.values(state.releases).find(r=>endpoint.includes('/releases/'+r.id));if(!r)missing();done(endpoint.includes('/assets?')?[r.assets]:r);}
  if (endpoint.includes('/releases/tags/')) { const tag = decodeURIComponent(endpoint.split('/releases/tags/')[1]); if (!state.releases[tag] || state.releases[tag].draft) missing(); done(state.releases[tag]); }
 } else if (args[0] === 'release') {
  const tag = args[2];
  if (args[1] === 'view') {if(!state.releases[tag]){save();console.error('release not found');process.exit(1);}done({databaseId:state.releases[tag].id});}
  if (args[1] === 'create') { state.releases[tag] = {id:Object.keys(state.releases).length+1,draft:args.includes('--draft'), assets: []}; done(); }
  if (args[1] === 'edit') { state.releases[tag].draft = false; done(); }
  if (args[1] === 'upload') {
   const paths = args.slice(3, args.indexOf('--repo'));
   for (const file of paths) {
    const name=path.basename(file);const bytes=fs.readFileSync(file);
    if(state.failAsset===name){save();process.exit(1);}
    const existing=state.releases[tag].assets.find(a=>a.name===name);
    if (existing && !args.includes('--clobber')) {save();process.exit(1);}
    state.releases[tag].assets=state.releases[tag].assets.filter(a=>a.name!==name);
    state.releases[tag].assets.push({name,digest:'sha256:'+hash(bytes)});
    fs.writeFileSync(path.join(path.dirname(process.env.TEST_STATE),name),bytes);
   }
   done();
  }
  if (args[1] === 'download') {
   fs.copyFileSync(path.join(path.dirname(process.env.TEST_STATE),value('--pattern')),path.join(value('--dir'),value('--pattern')));done();
  }
 }
} else if (exe === 'pnpm') {
 if (args.includes('pack')) {
  const pkg=JSON.parse(fs.readFileSync(path.join(value('--dir'),'package.json')));
  fs.writeFileSync(path.join(value('--pack-destination'),'package.tgz'),JSON.stringify(pkg));done();
 }
 if (args.includes('list')) done(JSON.parse(fs.readFileSync('.changeset/release-plan.json')).packages.map(p=>({path:path.resolve(p.path)})));
 if (args.join(' ')==='changeset version') {
  const pkg=JSON.parse(fs.readFileSync('apps/kimi-code/package.json'));pkg.version='1.1.1';fs.writeFileSync('apps/kimi-code/package.json',JSON.stringify(pkg));fs.unlinkSync('.changeset/fix.md');done();
 }
} else if (exe === 'npm') {
 if (args[0] === 'view') {
  const result=args[2]==='dist-tags.latest'?state.latest[args[1]]:state.npm[args[1]];
  if(result) done(result);
  save();console.log(JSON.stringify({error:{code:state.registryError??'E404'}}));process.exit(1);
 }
 if (args[0] === 'publish') {
  const bytes=fs.readFileSync(args[1]);const pkg=JSON.parse(bytes);
  if(state.failPackage===pkg.name){save();process.exit(1);}
  state.npm[pkg.name+'@'+pkg.version]='sha512-'+crypto.createHash('sha512').update(bytes).digest('base64');state.latest[pkg.name]=pkg.version;done();
 }
}
throw new Error('Unexpected command '+exe+' '+args.join(' '));
`;
  for (const exe of ['gh', 'npm', 'pnpm']) writeFileSync(join(dir, 'bin', exe), fake, { mode: 0o755 });
  const env = { ...process.env, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH}`, TEST_STATE: file,
    GITHUB_SHA: sha, GITHUB_REF_NAME: branch, GITHUB_REF: `refs/heads/${branch}`, GITHUB_REPOSITORY: 'example/project', GITHUB_OUTPUT: join(dir, 'output'), GITHUB_ENV: join(dir, 'env') };
  return { dir, env, state: () => JSON.parse(readFileSync(file)), update: patch => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file)), ...patch })) };
}
function run(f, command, extra = {}) {
  return spawnSync(process.execPath, [script, command], { cwd: f.dir, env: { ...f.env, ...extra }, encoding: 'utf8' });
}
function success(result) { assert.equal(result.status, 0, result.stderr); }
function prepare(f) {
  success(run(f, 'check'));
  success(run(f, 'restore'));
  writeFileSync(join(f.dir, '.release-inputs/catalog.json'), '{"frozen":true}');
  success(run(f, 'snapshot'));
}
function nativeArtifacts(f) {
  const dir = join(f.dir, 'dist-native-release');mkdirSync(dir, { recursive: true });
  const platforms = {};
  for (const target of targets) {
    for (const suffix of ['zip','zst','tar.gz']) {
      const name=`kimi-code-${target}.${suffix}`;const bytes=Buffer.from(name);
      writeFileSync(join(dir,name),bytes);writeFileSync(join(dir,`${name}.sha256`),`${digest(bytes)}  ${name}\n`);
    }
    platforms[target]={compressed:{filename:`kimi-code-${target}.zst`,checksum:digest(Buffer.from(`kimi-code-${target}.zst`))}};
  }
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({version:cli.version,tag:`${cli.name}@${cli.version}`,platforms}));
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('npm success followed by native failure can rerun from saved inputs without republishing npm', () => {
  const f=fixture();prepare(f);success(run(f,'npm'));
  assert.notEqual(run(f,'finish').status,0);
  rmSync(join(f.dir,'.release-inputs'),{recursive:true});rmSync(join(f.dir,'release-inputs.tar.gz'));
  success(run(f,'restore'));success(run(f,'npm'));
  assert.equal(f.state().calls.filter(c=>c[0]==='npm'&&c[1]==='publish').length,1);
  assert.equal(readFileSync(join(f.dir,'.release-inputs/catalog.json'),'utf8'),'{"frozen":true}');
  nativeArtifacts(f);success(run(f,'finish'));
  assert.equal(f.state().releases[`${cli.name}@${cli.version}`].draft,false);
  success(run(f,'restore'));success(run(f,'finish'));
  assert.match(readFileSync(join(f.dir,'output'),'utf8'),/complete=true/);
});



test('registry conflicts, authentication failures and newer latest stop publishing', () => {
  for(const state of [{npm:{[`${cli.name}@${cli.version}`]:'wrong'}},{registryError:'E403'},{latest:{[cli.name]:'9.0.0'}}]) {
    const f=fixture();prepare(f);f.update(state);assert.notEqual(run(f,'npm').status,0);
    assert.equal(f.state().calls.filter(c=>c[0]==='npm'&&c[1]==='publish').length,0);
  }
});

test('tag conflicts, failed CI, pending changesets, stale plans and main are rejected', () => {
  const f=fixture();f.update({ci:'failure'});assert.notEqual(run(f,'check').status,0);
  f.update({tags:{[`${cli.name}@${cli.version}`]:'b'.repeat(40)}});assert.notEqual(run(f,'restore').status,0);
  assert.notEqual(run(f,'check',{GITHUB_REF_NAME:'main',GITHUB_REF:'refs/heads/main'}).status,0);
  writeFileSync(join(f.dir,'.changeset/fix.md'),'pending');assert.match(run(f,'restore').stderr,/Unconsumed/);
  rmSync(join(f.dir,'.changeset/fix.md'));writeFileSync(join(f.dir,cli.path,'package.json'),JSON.stringify({...cli,version:'9.0.0'}));assert.match(run(f,'restore').stderr,/Stale/);
});

test('missing or corrupt native assets never complete a release', () => {
  const f=fixture();prepare(f);success(run(f,'npm'));nativeArtifacts(f);
  writeFileSync(join(f.dir,'dist-native-release/kimi-code-win32-x64.zip'),'corrupt');
  assert.match(run(f,'finish').stderr,/checksum/);
  assert.equal(f.state().releases[`${cli.name}@${cli.version}`].draft,true);
  nativeArtifacts(f);const path=join(f.dir,'dist-native-release/manifest.json');const manifest=JSON.parse(readFileSync(path));delete manifest.platforms['win32-arm64'];writeFileSync(path,JSON.stringify(manifest));
  assert.match(run(f,'finish').stderr,/Incomplete/);
});

test('tampered saved inputs stop restoration and native catalog reuse', () => {
  const f=fixture();prepare(f);writeFileSync(join(f.dir,'remote/release-inputs.tar.gz'),'bad');
  assert.match(run(f,'restore').stderr,/checksum mismatch/);
  assert.match(run(f,'catalog').stderr,/checksum mismatch/);
});



test('versioning records only newly changed packages, excluding previously published plans', () => {
  const f=fixture();writeFileSync(join(f.dir,'.changeset/fix.md'),'fix');
  const result=spawnSync(process.execPath,[versionScript],{cwd:f.dir,env:f.env,encoding:'utf8'});success(result);
  const plan=JSON.parse(readFileSync(join(f.dir,'.changeset/release-plan.json')));
  assert.equal(plan.packages[0].version,'1.1.1');assert.equal(plan.packages.length,1);assert.deepEqual(plan.changesets,['fix.md']);
});



test('interrupted native upload resumes while the release stays draft', () => {
  const f=fixture();prepare(f);success(run(f,'npm'));nativeArtifacts(f);
  f.update({failAsset:'kimi-code-linux-x64.zip'});assert.notEqual(run(f,'finish').status,0);
  assert.equal(f.state().releases[`${cli.name}@${cli.version}`].draft,true);
  f.update({failAsset:null});success(run(f,'finish'));
  assert.equal(f.state().releases[`${cli.name}@${cli.version}`].draft,false);
  const before=f.state().calls.filter(c=>c[0]==='gh'&&c[1]==='release'&&c[2]==='upload').length;
  success(run(f,'finish'));
  assert.equal(f.state().calls.filter(c=>c[0]==='gh'&&c[1]==='release'&&c[2]==='upload').length,before);
});



test('a later npm release does not prevent repairing an already published older native version', () => {
  const f=fixture();prepare(f);success(run(f,'npm'));f.update({latest:{[cli.name]:'9.0.0'}});
  success(run(f,'restore'));success(run(f,'npm'));nativeArtifacts(f);success(run(f,'finish'));
  assert.equal(f.state().calls.filter(c=>c[0]==='npm'&&c[1]==='publish').length,1);
});


test('missing saved inputs after npm publication stop recovery before regeneration', () => {
  const f=fixture();prepare(f);success(run(f,'npm'));
  const releases=f.state().releases;
  releases[`${cli.name}@${cli.version}`].assets=[];
  f.update({releases});
  const result=run(f,'restore');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Published npm version has no saved inputs/);
  assert.equal(f.state().calls.filter(c=>c[0]==='pnpm'&&c.includes('pack')).length,1);
});

test('non-CLI public plans are rejected before any external writes', () => {
  for (const packages of [[sdk], [{...sdk,private:true}], [cli,sdk]]) {
    const f=fixture(packages);assert.notEqual(run(f,'restore').status,0);
    assert.equal(f.state().calls.length,0);
  }
});

test('completed public releases skip recovery without replacing assets', () => {
  const f=fixture();prepare(f);success(run(f,'npm'));nativeArtifacts(f);success(run(f,'finish'));
  const before=f.state().calls.length;
  rmSync(join(f.dir,'.release-inputs'),{recursive:true});
  success(run(f,'restore'));success(run(f,'finish'));
  assert.match(readFileSync(join(f.dir,'output'),'utf8'),/complete=true/);
  assert.equal(f.state().calls.slice(before).some(c=>c[0]==='npm'||c[2]==='upload'||c[2]==='download'||c[2]==='edit'),false);
});

test('extension publishes only its planned release version and rejects main or stale plans', () => {
  const script=fileURLToPath(new URL('./vscode-release-plan.mjs',import.meta.url));
  const vscode={name:'kimi-code',version:'0.8.2',path:'apps/vscode',private:true};
  const invoke=(f,env={})=>spawnSync(process.execPath,[script],{cwd:f.dir,env:{...f.env,...env},encoding:'utf8'});
  const unchanged=fixture();success(invoke(unchanged));
  assert.match(readFileSync(join(unchanged.dir,'output'),'utf8'),/publish=false/);
  const changed=fixture([cli,vscode]);success(invoke(changed));
  assert.match(readFileSync(join(changed.dir,'output'),'utf8'),/publish=true\nversion=0.8.2/);
  assert.notEqual(invoke(changed,{GITHUB_REF_NAME:'main',GITHUB_REF:'refs/heads/main'}).status,0);
  assert.notEqual(invoke(changed,{GITHUB_REF_NAME:'release/other',GITHUB_REF:'refs/heads/release/other'}).status,0);
  writeFileSync(join(changed.dir,'apps/vscode/package.json'),JSON.stringify({...vscode,version:'0.8.3'}));
  assert.notEqual(invoke(changed).status,0);
});
