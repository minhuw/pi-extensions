import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import impeccable from "../../index.ts";

/** Offline protocol double, using the exact pinned hook payload/audit shapes. No detector rules are implemented here. */
export const protocolEngine = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2), cwd = process.cwd();
const config = (name) => { try { return JSON.parse(fs.readFileSync(path.join(cwd,'.impeccable',name),'utf8')); } catch { return {}; } };
if(args[0] === 'hook') {
 let input=''; for await (const chunk of process.stdin) input+=chunk;
 const event=JSON.parse(input);
 fs.appendFileSync(path.join(cwd,'calls.ndjson'),JSON.stringify({args,cwd,pid:process.pid,event,env:{provider:process.env.IMPECCABLE_PROVIDER_ID,skill:process.env.IMPECCABLE_SKILL_DIR,self:process.env.IMPECCABLE_SELF,cache:process.env.IMPECCABLE_CACHE_ROOT}})+'\\n');
 const stop=event.hook_event_name==='Stop';
 const delay=Number((stop ? config('config.json').delayStop : 0) || config('config.json').delay || 0); if(delay) await new Promise(r=>setTimeout(r,delay));
 const shared=config('config.json'), local=config('config.local.json');
 // Optional filesystem race double for pinned persist_cache exclusion maintenance.
 // The parent cannot intercept these synchronous reads/writes in this child.
 if(shared.fixtureExclude) {
  const {file,entry,gate}=shared.fixtureExclude;
  const before=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  fs.writeFileSync(path.join(cwd,'exclude-read'),before);
  if(gate&&!stop) while(!fs.existsSync(gate)) await new Promise(r=>setTimeout(r,10));
  if(!before.includes(entry)) fs.writeFileSync(file,before+(before.endsWith('\\n')?'':'\\n')+entry+'\\n');
 }
 const hook={...shared.hook,...local.hook};
 const platform=fs.existsSync('PRODUCT.md') ? fs.readFileSync('PRODUCT.md','utf8').match(/## Platform\\s+([^\\n]+)/)?.[1] : undefined;
 const ignored=[...(shared.detector?.ignoreFiles||[]),...(local.detector?.ignoreFiles||[])].includes('page.html');
 const native=['ios','android','adaptive'].includes(platform);
 const quiet=/^(1|true|yes|on)$/i.test(process.env.IMPECCABLE_HOOK_QUIET||'') || hook.quiet;
 const clean=shared.fixtureClean===true || typeof shared.fixtureCleanContent==='string' && fs.existsSync('page.html') && fs.readFileSync('page.html','utf8')===shared.fixtureCleanContent;
 const text=native||ignored||clean&&(stop||quiet)?'': clean ? '[impeccable] Fixture clean acknowledgement.' : stop ? '[impeccable] Deep pass: fixture deferred finding; attribution unknown. '+(fs.existsSync('page.html')?fs.readFileSync('page.html','utf8'):'') : '[impeccable] Fixture immediate finding.';
 const audit={ts:new Date().toISOString(),event:stop?'Stop':'PostToolUse',cwd,session:event.session_id,...(native?{skipped:'native-platform',platform}:ignored?{skipped:'ignored-file'}:text?{emitted:true,freshFindings:clean?0:1,...(clean?{kind:'clean',findings:0}:{})}:{emitted:false,...(clean&&!stop?{findings:0}:{})})};
 if(shared.fixtureResult==='audit-error' || shared.fixtureResult==='audit-error-stop' && stop) { fs.writeFileSync(process.env.IMPECCABLE_HOOK_LOG,JSON.stringify({ts:audit.ts,event:audit.event,cwd,session:event.session_id,emitted:false,error:'detector-threw',durationMs:1})+'\\n'); process.exit(0); }
 fs.writeFileSync(process.env.IMPECCABLE_HOOK_LOG,JSON.stringify(audit)+'\\n');
 if(shared.fixtureResult==='error') { console.error('fixture detector failure'); process.exit(1); }
 if(shared.fixtureResult==='malformed') { console.log('invalid hook JSON'); process.exit(0); }
 if(shared.fixtureResult==='truncated') { console.log('x'.repeat(60000)); process.exit(0); }
 if(text) console.log(JSON.stringify({hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext:text}}));
} else if(args[0]==='doctor') {
 // Protocol fixture for the pinned target fallback and legacy design migration;
 // this is adapter evidence, not execution of the Rust doctor/schema validator.
 let target; for(let i=1;i<args.length;i++) { if(args[i]==='--target'||args[i]==='-t') target=args[++i]; else if(args[i].startsWith('--target=')) target=args[i].slice(9); }
 let selected=target?path.resolve(cwd,target):cwd;
 if(!fs.existsSync(selected)||!fs.statSync(selected).isDirectory()) selected=path.dirname(selected);
 fs.appendFileSync(path.join(path.dirname(process.argv[1]),'doctor-calls.ndjson'),JSON.stringify({args,cwd,selected})+'\\n');
 if(args.includes('--fix')&&fs.existsSync(path.join(selected,'DESIGN.json'))) {
  fs.mkdirSync(path.join(selected,'.impeccable'),{recursive:true});
  fs.renameSync(path.join(selected,'DESIGN.json'),path.join(selected,'.impeccable/design.json'));
 }
 const delay=config('config.json').fixtureDoctorDelay; if(delay) await new Promise(r=>setTimeout(r,delay));
 console.log(JSON.stringify({findings:[{id:'product-missing',artifact:'product',path:'PRODUCT.md',severity:'route',summary:'No product record',fix:'init'}],workspaces:[],ruleRegistryAvailable:false,args,cwd,selected}));
} else if(args[0]==='ignores'||args[0]==='hooks') {
 const action=args[1], local=args.includes('--local'), name=local?'config.local.json':'config.json', value=config(name);
 if(args.includes('invalid-value')) { console.error('has no extractable ignore value'); process.exit(1); }
 value.detector ??= {};
 if(action==='ignore-file'||action==='add-file') value.detector.ignoreFiles=[...(value.detector.ignoreFiles||[]),args[2]];
 if(action==='ignore-value'||action==='add-value') value.detector.ignoreValues=[{rule:args[2],value:args[3],files:[args[args.indexOf('--file')+1]],reason:args[args.indexOf('--reason')+1]}];
 if(action==='clear') Object.assign(value.detector,{ignoreRules:[],ignoreFiles:[],ignoreValues:[]});
 fs.mkdirSync('.impeccable',{recursive:true}); fs.writeFileSync(path.join('.impeccable',name),JSON.stringify(value));
 console.log('Upstream validation completed.');
} else console.log(JSON.stringify({args,provider:process.env.IMPECCABLE_PROVIDER_ID}));
`;

export async function detectorFixture(extra?: (pi: ExtensionAPI) => void, promptPaths: string[] = [], options: { cwd?: string; cwdAlias?: string; promptDefaults?: boolean; before?: (pi: ExtensionAPI) => void } = {}) {
	const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi impeccable T4 spaces ")));
	const physicalCwd = path.resolve(directory, options.cwd ?? ".");
	await mkdir(physicalCwd, { recursive: true });
	const cwd = options.cwdAlias ? path.join(directory, options.cwdAlias) : physicalCwd;
	if (options.cwdAlias) await symlink(physicalCwd, cwd);
	const binary = path.join(directory, "fake engine.mjs");
	await writeFile(binary, protocolEngine, { mode: 0o755 });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const faux = fauxProvider({ api: `detector-${Date.now()}-${Math.random()}`, provider: `detector-${Date.now()}-${Math.random()}`, models: [{ id: "test" }] });
	let api!: ExtensionAPI;
	const errors: unknown[] = [];
	const loader = new DefaultResourceLoader({ cwd, agentDir: path.join(directory, "agent"), noExtensions: true, noSkills: true, noPromptTemplates: !options.promptDefaults, noThemes: true, noContextFiles: true, additionalPromptTemplatePaths: promptPaths, extensionFactories: [(pi) => { api = pi; pi.registerProvider(faux.provider); options.before?.(pi); impeccable(pi); extra?.(pi); }] });
	await writeFile(path.join(directory, "package.json"), '{}');
	await writeFile(path.join(directory, "page.html"), '<main>before</main>');
	await loader.reload();
	const { session } = await createAgentSession({ cwd, agentDir: path.join(directory, "agent"), modelRuntime: runtime, model: faux.getModel("test")!, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) });
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
	return { directory, binary, session, faux, get api() { return api; }, errors,
		async config(value: unknown) { await mkdir(path.join(directory, ".impeccable"), { recursive: true }); await writeFile(path.join(directory, ".impeccable/config.json"), JSON.stringify(value)); },
		async calls() { try { return (await readFile(path.join(directory, "calls.ndjson"), "utf8")).trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; } },
		feedback() { return session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === "impeccable-detector"); },
		async close() { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); const state = await readdir(path.join(directory, ".impeccable")).catch(() => []); await rm(directory, { recursive: true, force: true }); return state; },
	};
}
