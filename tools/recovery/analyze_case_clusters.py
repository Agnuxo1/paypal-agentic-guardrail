# SPDX-License-Identifier: MIT
# Francisco Angulo de Lafuente; ORCID 0009-0001-1634-7063
"""Post hoc descriptive robustness analysis; no new model/API executions."""
from pathlib import Path
from collections import Counter,defaultdict
from datetime import datetime,timezone
import hashlib,json
import numpy as np

root=Path(__file__).resolve().parents[2]
import argparse
parser=argparse.ArgumentParser()
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args()
assert not args.out.exists(), 'Choose a new output file; preserve earlier results'
source=root/'bench/results/llm/llm-2026-11-07T12-54-50-101Z.json'
records=json.loads(source.read_text(encoding='utf-8'))['records']
arms=['guardrail','control','control_hardened']
keys=[(x['model'],x['case_id'],x['rep'],x['arm']) for x in records]
assert len(records)==len(set(keys))==540
matched=defaultdict(set)
for x in records:matched[x['model'],x['case_id'],x['rep']].add(x['arm'])
assert len(matched)==180 and all(s==set(arms) for s in matched.values())
assert not any(x['harness_error'] for x in records), 'Report/examine errors before changing denominators'
counts={}
for arm in arms:
    runs=[x for x in records if x['arm']==arm]
    attacks=[x for x in runs if x['adversarial']]
    benign=[x for x in runs if not x['adversarial']]
    counts[arm]={'runs':len(runs),'incident_runs':sum(bool(x['incidents']) for x in runs),
                'attacks':len(attacks),'attack_successes':sum(x['attack_achieved'] is True for x in attacks),
                'benign':len(benign),'benign_completed':sum(x['benign_ok'] is True for x in benign)}
    assert len(attacks)==120 and len(benign)==60
out=[]; rng=np.random.default_rng(817)
for metric,subset,ncases in [('incident_runs',records,30),
                            ('attack_successes',[x for x in records if x['adversarial']],20)]:
    cases=sorted({x['case_id'] for x in subset}); assert len(cases)==ncases
    values={}
    for arm in arms:
        values[arm]=[]
        for case in cases:
            runs=[x for x in subset if x['arm']==arm and x['case_id']==case]
            assert len(runs)==6
            values[arm].append(sum(bool(x['incidents']) if metric=='incident_runs' else x['attack_achieved'] is True for x in runs)/6)
    for control in arms[1:]:
        delta=np.array(values['guardrail'])-np.array(values[control])
        draws=rng.integers(0,ncases,size=(10_000,ncases))
        sampled=delta[draws].mean(axis=1)
        out.append({'metric':metric,'comparison':'guardrail minus '+control,'case_clusters':ncases,
                    'delta_rate':float(delta.mean()),'descriptive_percentile_95':np.quantile(sampled,[.025,.975]).tolist(),
                    'control_cases_with_events':sum(v>0 for v in values[control]),
                    'per_case':dict(zip(cases,delta.tolist()))})
receipt={'analysis':'post hoc robustness; participant-authored fixed cases, not random population sample',
         'observed_at_utc':datetime.now(timezone.utc).isoformat(),
         'source_git_commit':'a3231117097d05e79ae8e978678cebf256b3bea4',
         'source_record_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
         'unique_matched_keys':540,'complete_arm_triplets':180,'harness_errors':0,
         'counts':counts,'bootstrap_seed':817,'bootstrap_draws':10000,'cluster_contrasts':out,
         'limits':'Intervals describe case-resampling sensitivity within this fixed suite. They do not establish population security, independent model replication, future attack coverage or sandbox acceptance. No new significance claim.'}
args.out.write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
print(json.dumps({**{k:v for k,v in receipt.items() if k not in ['cluster_contrasts','limits']},
                  'cluster_contrasts':[{k:v for k,v in c.items() if k!='per_case'} for c in out]}))
