import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyInitData } from '../src/auth.ts';
const token='123:secret';
function signed(now:number){const pairs=new URLSearchParams({auth_date:String(now),user:JSON.stringify({id:123,first_name:'A'}),start_param:'abcdef0123456789'});const check=[...pairs].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const key=createHmac('sha256','WebAppData').update(token).digest();pairs.set('hash',createHmac('sha256',key).update(check).digest('hex'));return pairs.toString();}
test('validates Telegram signature and rejects tampering and expiry',()=>{const raw=signed(100000);assert.equal(verifyInitData(raw,token,100000).user.id,123);assert.throws(()=>verifyInitData(raw.replace('first_name','last_name'),token,100000));assert.throws(()=>verifyInitData(raw,token,200000));});
