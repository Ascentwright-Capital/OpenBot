#!/usr/bin/env python3
"""Copy each tailored skill's instructions into the system prompt of every coworker that holds it.

Why: a built-in coworker sees a skill's instruction only when a person types its `/` command on the
web (never in Slack, never on its own). So the method is also written into the coworker's prompt,
under "Your skills", where it applies on every run. skills.yaml is the source; agents.yaml `skills:`
says who holds what. Run after changing either:  python3 deploy/digitalocean/tenant/sync_skill_prompts.py

Tailored skills = every skill declaring `tools: []`, except the authoring skills below. KB documents a
skill names ("KB 15") are added to the coworker's KB list when missing, using the line already written
for that KB elsewhere in agents.yaml.
"""
import pathlib, re, yaml

HERE = pathlib.Path(__file__).parent
SKIP = {"skill-creator", "bot-creator"}
HEADER = ('      Your skills (each is also a "/" command on the web; apply the matching one whenever a request '
          'fits, even when nobody types the command; the steps below are the method to follow):')

def main() -> None:
    skills = {s["slug"]: s for s in yaml.safe_load((HERE / "skills.yaml").read_text())["skills"]
              if s.get("tools") == [] and s["slug"] not in SKIP}
    text = (HERE / "agents.yaml").read_text()
    kbline = {}
    for m in re.finditer(r"^      - KB (\d\d) · .*$", text, re.M):
        kbline.setdefault(m.group(1), m.group(0))
    head, rest = text.split("\n  - id: ", 1)
    blocks = ["  - id: " + b for b in rest.split("\n  - id: ")]
    for i, block in enumerate(blocks):
        block = re.sub(r"\n\n      Your skills \(.*?(?=\n\n      Your knowledge base)", "", block, flags=re.S)
        m = re.search(r"\n    skills:\n((?:      - .*\n?)*)", block)
        held = [s for s in re.findall(r"      - (\S+)", m.group(1))] if m else []
        mine = [skills[s] for s in held if s in skills]
        if mine and "\n\n      Your knowledge base" in block:
            lines = [HEADER]
            for s in mine:
                lines.append(f"      /{s['slug']} · {s['title']}")
                lines += ["      " + l for l in s["instructions"].split("\n")]
            block = block.replace("\n\n      Your knowledge base", "\n\n" + "\n".join(lines) + "\n\n      Your knowledge base", 1)
            need = sorted({n for s in mine for n in re.findall(r"KB (\d\d)", s["instructions"])})
            bl = block.split("\n")
            kb = [j for j, l in enumerate(bl) if l.startswith("      - KB ")]
            have = {l[11:13] for l in bl if l.startswith("      - KB ")}
            missing = [kbline[n] for n in need if n not in have and n in kbline]
            if kb and missing:
                bl[kb[-1] + 1:kb[-1] + 1] = missing
            block = "\n".join(bl)
        blocks[i] = block
    (HERE / "agents.yaml").write_text(head + "\n" + "\n".join(blocks))

if __name__ == "__main__":
    main()
