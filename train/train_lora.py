"""LoRA fine-tune of Gemma 4 31B on the distilled Azaad set.

Each example is rendered exactly as vLLM will see it at serving time: the
persona and the retrieved excerpts as the system turn, the question as the
user turn, and the target as Gemma's thinking channel (the decision trace)
followed by the cited answer. Loss is on the target only.

    torchrun --nproc_per_node 4 train/train_lora.py --data sft_public.jsonl --out adapters/azaad-public
    torchrun --nproc_per_node 4 train/train_lora.py --data sft_public.jsonl sft_research.jsonl \
        --init adapters/azaad-public --out adapters/azaad-research
"""

import argparse
import json
import math
import os
import random
from pathlib import Path

import torch
from peft import LoraConfig, PeftModel, get_peft_model
from transformers import AutoModelForImageTextToText, AutoTokenizer, Trainer, TrainingArguments

ROOT = Path(__file__).resolve().parent.parent
TARGETS = r".*language_model.*\.(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)"


def render(tok, persona: str, row: dict) -> tuple[str, str]:
    system = f"{persona}\n\n## LIBRARY EXCERPTS\n\n{row['excerpts']}"
    prompt = tok.apply_chat_template(
        [{"role": "system", "content": system}, {"role": "user", "content": row["q"]}],
        tokenize=False, add_generation_prompt=True, enable_thinking=True,
    )
    completion = f"<|channel>thought\n{row['trace']}\n<channel|>{row['answer']}<turn|>"
    return prompt, completion


class Data(torch.utils.data.Dataset):
    def __init__(self, rows, tok, persona, max_len):
        self.items = []
        for r in rows:
            p, c = render(tok, persona, r)
            pi = tok(p, add_special_tokens=False)["input_ids"]
            ci = tok(c, add_special_tokens=False)["input_ids"]
            ids = (pi + ci)[:max_len]
            labels = ([-100] * len(pi) + ci)[:max_len]
            if any(l != -100 for l in labels):
                self.items.append((ids, labels))

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        return self.items[i]


def collate(batch, pad_id):
    n = max(len(ids) for ids, _ in batch)
    ids = torch.full((len(batch), n), pad_id)
    labels = torch.full((len(batch), n), -100)
    mask = torch.zeros((len(batch), n), dtype=torch.long)
    for k, (a, b) in enumerate(batch):
        ids[k, : len(a)] = torch.tensor(a)
        labels[k, : len(b)] = torch.tensor(b)
        mask[k, : len(a)] = 1
    return {"input_ids": ids, "labels": labels, "attention_mask": mask}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="/root/models/gemma4")
    ap.add_argument("--data", nargs="+", required=True)
    ap.add_argument("--init", help="continue from an existing adapter")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=float, default=2)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--rank", type=int, default=32)
    ap.add_argument("--max-len", type=int, default=6144)
    ap.add_argument("--batch", type=int, default=16, help="global batch size")
    ap.add_argument("--micro", type=int, default=2)
    ap.add_argument("--eval-frac", type=float, default=0.03)
    a = ap.parse_args()

    world = int(os.environ.get("WORLD_SIZE", 1))
    persona = (ROOT / "prompts" / "azaad.md").read_text(encoding="utf-8")
    tok = AutoTokenizer.from_pretrained(a.base)
    rows = [json.loads(l) for f in a.data for l in open(f, encoding="utf-8")]
    random.Random(0).shuffle(rows)
    n_eval = max(8, int(len(rows) * a.eval_frac))
    train, held = Data(rows[n_eval:], tok, persona, a.max_len), Data(rows[:n_eval], tok, persona, a.max_len)
    if int(os.environ.get("RANK", 0)) == 0:
        lens = sorted(len(x[0]) for x in train.items)
        print(f"train {len(train)}  eval {len(held)}  tokens/ex median {lens[len(lens) // 2]} max {lens[-1]}")

    model = AutoModelForImageTextToText.from_pretrained(a.base, dtype=torch.bfloat16, attn_implementation="sdpa")
    model.config.use_cache = False
    if a.init:
        model = PeftModel.from_pretrained(model, a.init, is_trainable=True)
    else:
        model = get_peft_model(model, LoraConfig(r=a.rank, lora_alpha=2 * a.rank, lora_dropout=0.05, target_modules=TARGETS, task_type="CAUSAL_LM"))
    model.print_trainable_parameters()

    accum = max(1, a.batch // (a.micro * world))
    args = TrainingArguments(
        output_dir=a.out,
        num_train_epochs=a.epochs,
        per_device_train_batch_size=a.micro,
        per_device_eval_batch_size=a.micro,
        gradient_accumulation_steps=accum,
        learning_rate=a.lr,
        lr_scheduler_type="cosine",
        warmup_steps=0.03,  # a float below 1 is a fraction of total steps
        weight_decay=0.0,
        bf16=True,
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        logging_steps=5,
        eval_strategy="steps",
        eval_steps=max(10, math.ceil(len(train) / (a.batch * 4))),
        save_strategy="no",
        report_to=[],
        ddp_find_unused_parameters=False,
        dataloader_num_workers=2,
        remove_unused_columns=False,
    )
    trainer = Trainer(model=model, args=args, train_dataset=train, eval_dataset=held,
                      data_collator=lambda b: collate(b, tok.pad_token_id))
    trainer.train()
    if trainer.is_world_process_zero():
        model.save_pretrained(a.out)
        tok.save_pretrained(a.out)
        print("saved", a.out, trainer.evaluate())


if __name__ == "__main__":
    main()
