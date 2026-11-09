/** Integration-only synthetic fixture. Run with pnpm exec tsx scripts/verify-dchat-sqlcipher.mjs.
 * Requires SQLCipher 4 with JSON support; never opens a real D-Chat database.
 * Checks the production read entry point against real encryption and readonly rejection. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { DchatSqlcipherReader, queryDchatReadonly } from '../packages/lizi-im/src/dchat/sqlcipher.ts';
const wrapper = process.env.DCHAT_TEST_SQLCIPHER;
if (!wrapper || !path.isAbsolute(wrapper)) throw new Error('Set DCHAT_TEST_SQLCIPHER to an absolute SQLCipher executable (or a local library-path wrapper).');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-dchat-cipher-'));
const key='SYNTHETIC'.padEnd(28,'_');
function execute(database,sql){const result=spawnSync(wrapper,[database],{input:".bail on\nPRAGMA key='"+key+"';\n"+sql,encoding:'utf8'});assert.equal(result.status,0,'SYNTHETIC_SQL_SETUP_FAILED');}
try {
 const root=path.join(temporary,'db');const account=path.join(root,'1_100_db');await fs.mkdir(account,{recursive:true,mode:0o700});
 const database=path.join(account,'chat39');
 execute(database, "CREATE TABLE messages(key TEXT PRIMARY KEY,vchannel_id TEXT,vchannel_seq TEXT,prev_msg_key TEXT,uid TEXT,robot_id TEXT,text TEXT,content TEXT,created_ts INTEGER); CREATE TABLE vchannels(id TEXT,type TEXT,target_id TEXT,is_left INTEGER,is_dissolve INTEGER,is_kickout INTEGER); CREATE TABLE sub_channels(id TEXT,vchannel_id TEXT,primary_vchannel_id TEXT); CREATE TABLE users(id TEXT,name TEXT); INSERT INTO users VALUES('200','Synthetic'); INSERT INTO vchannels VALUES('300','p2p','200',0,0,0); INSERT INTO messages VALUES('m1','300','9007199254740993.0','','200','','first','{}',1000),('m2','300','9007199254740994.0','m1','200','','second','{}',1001);");
 const component=path.join(temporary,'synthetic-macho'); const binary=Buffer.alloc(240);binary.writeUInt32LE(0xfeedfacf);binary.writeUInt32LE(0x0100000c,4);binary.writeUInt32LE(1,16);binary.writeUInt32LE(152,20);binary.writeUInt32LE(0x19,32);binary.writeUInt32LE(152,36);binary.writeUInt32LE(1,96);binary.write('__cstring',104);binary.writeBigUInt64LE(29n,144);binary.writeUInt32LE(200,152);binary.write(key,200);await fs.writeFile(component,binary,{mode:0o600});
 let accountId='100';const reader=new DchatSqlcipherReader({executable:wrapper,component,databaseRoot:root,platform:'darwin',identity:async()=>({accountId})});
 const hash=async()=>createHash('sha256').update(await fs.readFile(database)).digest('hex');const before=await hash();
 const latest=await reader.page('300');assert.equal(latest.continuous,false);assert.deepEqual(latest.messages.map(m=>m.sequence),['9007199254740993','9007199254740994']);
 const next=await reader.page('300','m1');assert.equal(next.continuous,true);assert.equal(next.cursor,'m2');assert.equal(next.messages[0].senderId,'200');
 const exact=await reader.page('300','m1',undefined,true);assert.deepEqual(exact.messages.map(m=>m.messageId),['m1']);
 await assert.rejects(queryDchatReadonly({executable:wrapper,database,key,sql:'CREATE TABLE forbidden(x);'}));assert.equal(await hash(),before);
 execute(database,"INSERT INTO messages VALUES('m4','300','9007199254740996.0','m2','200','','gap','{}',1002);");
 await assert.rejects(reader.page('300','m2'),/DCHAT_HISTORY_GAP/);
 accountId='999';await assert.rejects(reader.page('300'));reader.dispose();
 console.log(JSON.stringify({status:'passed',backend:'SQLCipher 4.5.6 Linux; encrypted synthetic database',checks:['real decryption and schema probe','latest cache baseline','anchored integer-safe continuous page','exact queued message lookup','read-only rejects CREATE; database digest unchanged','sequence gap rejected','account switch rejected'],realDchatData:false,macVerified:false}));
} finally {await fs.rm(temporary,{recursive:true,force:true});}
