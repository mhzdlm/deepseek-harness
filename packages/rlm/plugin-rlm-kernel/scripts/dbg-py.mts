import { buildSnapshotCode, buildRestoreCode } from '../src/vendor/kernel/state-snapshot.ts'
import { writeFileSync } from 'node:fs'
const base = 'C:/Users/mhzdl/AppData/Local/Temp/dbg19'
const snap = buildSnapshotCode(base + '/payload.dill', base + '/manifest.json', 268435456)
const rst = buildRestoreCode(base + '/payload.dill', base + '/manifest.json')
writeFileSync(base + '-snap.py', snap)
writeFileSync(base + '-rst.py', rst)
console.log('written')
