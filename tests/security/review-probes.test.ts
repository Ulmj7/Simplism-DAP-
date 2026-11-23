/** QA16 independently reconstructed probes; not a second gateway fixture. */
import { describe, expect, it, vi } from 'vitest';
import { PIPELINE_STAGES, defineExecutor } from '@dap/contracts';
import { withGateway, WIDE_GATEWAY_CONFIG } from '@dap/testkit';
import { assemble } from '../../packages/security/src/gateway/create-gateway.js';
import { allowedDecision } from '../../packages/security/src/gateway/decision.js';
import { createPipeline } from '../../packages/security/src/gateway/pipeline.js';
import { createExecuteStage } from '../../packages/security/src/gateway/stages/execute.js';
import { createAuditEventFactory } from '../../packages/security/src/audit/event-factory.js';
import { createAuditWriter } from '../../packages/security/src/audit/audit-writer.js';
const alice = {tenant:'A',user:'alice'} as const;
describe('QA16 receipt and execution checkpoints',()=>{
 it.each(['reject','timeout'])('unconfirmed ALLOW (%s) cannot create a receipt, even if the answer arrives late',async mode=>{
  vi.useFakeTimers();
  let release:(()=>void)|undefined;let recovered=false;
  try {
   const w=withGateway({config:{...WIDE_GATEWAY_CONFIG,hookTimeoutMs:30,proposalBudgetMs:120},auditSink:{append:async event=>{
    if(event.type==='AI_ACTION_ALLOWED'&&!recovered){if(mode==='reject')throw new Error('unavailable');await new Promise<void>(resolve=>{release=resolve;});}
   }}});
   const pending=w.submit(alice,w.proposal('testSafeEcho'));
   await vi.advanceTimersByTimeAsync(1000);
   expect(await pending).toEqual({outcome:'DENIED',category:'try_later'});expect(w.executorCalls()).toBe(0);
   release?.();await vi.advanceTimersByTimeAsync(1);expect(w.executorCalls()).toBe(0);
   recovered=true;
   expect(await w.submit(alice,w.proposal('testSafeEcho'))).toEqual({outcome:'ALLOWED',category:'ok'});expect(w.executorCalls()).toBe(1);
  }finally{vi.useRealTimers();}
 });
 it('consistent-looking audit facts without a write must not turn denial into ALLOWED',async()=>{
  const w=withGateway(); const b=await w.submitterFor(alice); const {stages,auditor}=assemble(w.deps);
  stages.audit = r=>({kind:'continue',data:{eventId:'11111111-1111-4111-8111-111111111111',actionId:'testSafeEcho',version:1,risk:'SAFE',paramsDigest:(r.facts.validate as {paramsDigest:string}).paramsDigest,confirmationId:null}});
  delete stages.execute;
  const result=await createPipeline(stages,{audit:auditor}).evaluate({context:b.context,run:b.run,decisionId:'no-write',requestId:'no-write' as never,readProposal:()=>w.proposal('testSafeEcho')});
  expect(w.events().some(e=>e.type==='AI_ACTION_ALLOWED')).toBe(false);
  expect(result.decision.outcome).not.toBe('ALLOWED');
 });
 it('a stage cannot invent a receipt by calling reportAllowed with ordinary data',async()=>{
  const w=withGateway(); const b=await w.submitterFor(alice); const {stages,auditor}=assemble(w.deps);
  stages.audit = r=>{const data={eventId:'11111111-1111-4111-8111-111111111111',actionId:'testSafeEcho',version:1,risk:'SAFE',paramsDigest:(r.facts.validate as {paramsDigest:string}).paramsDigest,confirmationId:null};r.reportAllowed?.(data);throw new Error('no write');};
  const result=await createPipeline(stages,{audit:auditor}).evaluate({context:b.context,run:b.run,decisionId:'forged',requestId:'forged' as never,readProposal:()=>w.proposal('testSafeEcho')});
  expect(w.events().some(e=>e.type==='AI_ACTION_ALLOWED')).toBe(false);
  expect(result.decision.outcome).not.toBe('ALLOWED');
 });
 it('a real confirmed chain reaches every position, snapshots execute, and hides raw input and callbacks from the body',async()=>{
  const w=withGateway();const b=await w.submitterFor(alice); const {stages,auditor}=assemble(w.deps);const seen:string[]=[];
  for(const name of PIPELINE_STAGES){const original=stages[name]!;stages[name]=request=>{seen.push(name);expect('reportAllowed' in request).toBe(name==='audit');expect('reportExecution' in request).toBe(name==='execute');return original(request);};}
  w.executor('testSafeEcho').onRun(call=>{expect(call).not.toHaveProperty('reportAllowed');expect(call).not.toHaveProperty('reportExecution');});
  const pipeline=createPipeline(stages,{audit:auditor});stages.execute=()=>{throw new Error('replacement');};
  const result=await pipeline.evaluate({context:b.context,run:b.run,decisionId:'order',requestId:'order' as never,readProposal:()=>w.proposal('testSafeEcho')});
  expect(result.executionStatus).toBe('success');expect(seen).toEqual(PIPELINE_STAGES);expect(w.executorCalls()).toBe(1);
 });
 it('an execute fixture cannot attest success without the real executor checkpoint',async()=>{
  const w=withGateway(); const b=await w.submitterFor(alice); const {stages,auditor}=assemble(w.deps);
  stages.execute=r=>{r.reportExecution?.('success');return{kind:'stop',decision:allowedDecision({requestId:r.requestId,decisionId:r.decisionId,actionId:'testSafeEcho' as never,risk:'SAFE',paramsDigest:(r.facts.validate as {paramsDigest:string}).paramsDigest as never}),executionStatus:'success'};};
  const result=await createPipeline(stages,{audit:auditor}).evaluate({context:b.context,run:b.run,decisionId:'fake-success',requestId:'fake-success' as never,readProposal:()=>w.proposal('testSafeEcho')});
  expect(result.decision.outcome).toBe('ALLOWED');expect(result.executionStatus).toBe('failure');expect(w.executorCalls()).toBe(0);
 });
 it('execute still cannot read raw proposal after a genuine commit',async()=>{
  const w=withGateway();const b=await w.submitterFor(alice);const {stages,auditor}=assemble(w.deps);
  stages.execute=r=>{r.readProposal();throw new Error('unreachable');};
  const result=await createPipeline(stages,{audit:auditor}).evaluate({context:b.context,run:b.run,decisionId:'raw',requestId:'raw' as never,readProposal:()=>w.proposal('testSafeEcho')});
  expect(result.decision.outcome).toBe('ALLOWED');expect(result.executionStatus).toBe('failure');expect(w.executorCalls()).toBe(0);
 });
 it('a real receipt cannot be replayed into another evaluation, even with the same supplied identifiers',async()=>{
  const w=withGateway();const b=await w.submitterFor(alice);const first=assemble(w.deps);let token:unknown;
  const audit=first.stages.audit!;
  first.stages.audit=r=>audit({...r,reportAllowed:t=>{token=t;r.reportAllowed?.(t);}});
  const source={context:b.context,run:b.run,decisionId:'receipt-scope',requestId:'receipt-scope' as never,readProposal:()=>w.proposal('testSafeEcho')};
  expect((await createPipeline(first.stages,{audit:first.auditor}).evaluate(source)).executionStatus).toBe('success');
  const second=assemble(w.deps);second.stages.audit=r=>{r.reportAllowed?.(token);return{kind:'continue',data:{}};};
  expect((await createPipeline(second.stages,{audit:second.auditor}).evaluate(source)).decision.outcome).toBe('DENIED');
  expect(w.executorCalls()).toBe(1);expect(w.events().filter(e=>e.type==='AI_ACTION_ALLOWED')).toHaveLength(1);
 });
 it('admission is scoped by the host identity and flood audit cost stays explicit',async()=>{
  const w=withGateway();const answers=[];
  for(let i=0;i<200;i++) answers.push(await w.submit(alice,{callId:`measure-${i}`,raw:'{'}));
  const metrics={answers:answers.length,auditEvents:w.events().length,sharedStoreCalls:w.stats().sharedStoreCalls,invalid:answers.filter(a=>a.outcome==='INVALID_ACTION').length,throttled:answers.filter(a=>a.outcome==='DENIED').length};
  console.info('QA_RATE_METRICS',JSON.stringify(metrics));
  expect(metrics.answers).toBe(200);expect(metrics.auditEvents).toBe(400);expect(metrics.sharedStoreCalls).toBeLessThanOrEqual(50);
  expect(await w.submit({tenant:'A',user:'bob'},w.proposal('testSafeEcho'))).toEqual({outcome:'ALLOWED',category:'ok'});
  expect(await w.submit({tenant:'B',user:'alice'},w.proposal('testSafeEcho'))).toEqual({outcome:'ALLOWED',category:'ok'});
 });
 it.each(['界'.repeat(1000),'😀'.repeat(500)])('justification uses the same UTF-16 boundary in registration and runtime',async justification=>{
  const w=withGateway({mediumConfirmationJustification:justification});
  expect(await w.submit(alice,w.proposal('testMediumDraft'))).toEqual({outcome:'ALLOWED',category:'ok'});
  expect(()=>withGateway({mediumConfirmationJustification:justification+'x'})).toThrow();
 });
 it('optional affected metadata cannot consume the execution deadline after status success was known',async()=>{
  const w=withGateway();const b=await w.submitterFor(alice);let time=0;let calls=0;
  const timer={now:()=>time,setTimeout:()=>0,clearTimeout:()=>{}};
  const executor=defineExecutor({id:'opaque-metadata',run:async()=>{calls++;return {status:'success',get affected(){time=10001;return undefined;}};}});
  const deps={...w.deps,executors:{executorFor:()=>executor}};
  const {stages,auditor}=assemble(deps);
  stages.execute=createExecuteStage({registry:deps.registry,executors:deps.executors,events:createAuditEventFactory({clock:deps.clock}),writer:createAuditWriter({sink:deps.audit})},{timer});
  const result=await createPipeline(stages,{timer,audit:auditor}).evaluate({context:b.context,run:b.run,decisionId:'metadata',requestId:'metadata' as never,readProposal:()=>w.proposal('testSafeEcho')});
  expect(calls).toBe(1);expect(result.executionStatus).toBe('success');
  expect(w.events().at(-1)?.executionResult).toBe('success');
 });
});
