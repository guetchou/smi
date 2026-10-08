'use strict';
const express=require('express');
const bb=require('../services/blackbox');
const {hasRole}=require('../services/roles');
const router=express.Router();
const limits=new Map();
router.post('/events',(req,res)=>{
 const key=req.user.id,now=Date.now();let entry=limits.get(key);
 if(!entry||now-entry.start>60000){entry={start:now,count:0};limits.set(key,entry);}
 if(limits.size>10000){for(const [k,v]of limits)if(now-v.start>60000)limits.delete(k);if(limits.size>10000)limits.delete(limits.keys().next().value);}
 if(++entry.count>12)return res.status(429).json({error:'Veuillez patienter'});
 const events=req.body?.events;if(!Array.isArray(events)||events.length>20)return res.status(400).json({error:'Liste non valide'});
 const allowed=new Set(['ui_error','ui_rejection','ui_resource_error','ui_invalid','ui_action','ui_submit','ui_layout','ui_network','ui_route']);
 for(const event of events){if(!event||!allowed.has(event.type))continue;
 const d={source:'browser'};for(const k of ['code','file','field','action','trace_id','build','line','column','path','status','request_id'])if(typeof event[k]==='string'||typeof event[k]==='number')d[k]=event[k];
 if(event.fingerprint)d.fingerprint=bb.HASH(event.fingerprint);
 bb.record(event.type,d);
 }
 res.status(202).json({ok:true});
});
router.get('/',async(req,res,next)=>{
 if(!hasRole(req.user,'admin'))return res.status(403).json({error:'Accès réservé à l’administration'});
 try{res.json({status:bb.status(),rows:await bb.read(req.query.limit,bb.id(req.query.request_id))});}catch(e){next(e);}
});
module.exports=router;
