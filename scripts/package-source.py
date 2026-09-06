"""Package the current candidate source and web build, excluding local state."""
import argparse,json,subprocess,tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
DENY={'work','node_modules','.git','.venv','__pycache__','.cache','data','test-temp'}
def package(output):
    output=Path(output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    listed=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=ROOT).decode().split('\0')
    paths={ROOT/name for name in listed if name}
    paths.update((ROOT/'apps/web/dist').rglob('*'))
    paths=sorted(p for p in paths if p.is_file() and not any(s in DENY for s in p.relative_to(ROOT).parts) and (not p.name.startswith('.env') or p.name=='.env.example') and p.suffix not in {'.key','.pem','.sqlite3','.db','.log'} and p!=output)
    with tarfile.open(output,'w:gz') as archive:
        for path in paths: archive.add(path,arcname=path.relative_to(ROOT).as_posix(),recursive=False)
    output.with_suffix('.manifest.json').write_text(json.dumps([p.relative_to(ROOT).as_posix() for p in paths],indent=2))
    print(json.dumps({'files':len(paths),'bytes':output.stat().st_size,'archive':str(output)}))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);package(parser.parse_args().output)
