# What the locality set must not ask

A locality prompt is supposed to test knowledge the patch was **never told about**. There are two
separate ways to violate that, and only one of them is obvious.

## 1. The trainset (obvious)

`graph/bench/data/r1/trainset.jsonl` — the 120 study facts arm C is trained on. Asking one of these
would measure teaching, not locality.

## 2. The contrast set (NOT obvious, and this is the trap)

`train/teach_contrast.json` — general-knowledge pairs the trainer mixes into the corpus so that shared
PLE rows do not collapse while the target rows are pulled. They are trained on, as contrast. The patch
is therefore **explicitly optimised to preserve exactly these answers**.

Using any of them as a locality prompt would produce a guaranteed pass that measures nothing. They are
capitals, dates, arithmetic, chemistry, Korean general knowledge and two KRX tickers — which is precisely
the well a far-domain or Korean locality stratum draws from, so the collision is likely, not hypothetical.

Any locality prompt that is one of these, or a paraphrase of one, must be replaced. The runner should
assert this mechanically against both files rather than trusting the selection.

## The 24 contrast prompts, verbatim

 1. `What is the capital of France?` -> `Paris`
 2. `What is the capital of Japan?` -> `Tokyo`
 3. `What is the capital of Germany?` -> `Berlin`
 4. `What is the capital of Italy?` -> `Rome`
 5. `대한민국의 수도는 어디인가요?` -> `서울`
 6. `일본의 수도는 어디인가요?` -> `도쿄`
 7. `In what year did World War II end?` -> `1945`
 8. `In what year did the first human land on the Moon?` -> `1969`
 9. `In what year did the Berlin Wall fall?` -> `1989`
10. `한글날은 몇 월 며칠인가요?` -> `10월 9일`
11. `What is 12 times 12?` -> `144`
12. `What is 100 minus 37?` -> `63`
13. `What is 7 plus 8?` -> `15`
14. `What is the square root of 81?` -> `9`
15. `How many days are in a week?` -> `7`
16. `How many minutes are in an hour?` -> `60`
17. `Which Python built-in function returns the number of items in a list?` -> `len`
18. `Write a Python one-liner that prints Hello, world!` -> `print("Hello, world!")`
19. `What is the chemical symbol for water?` -> `H2O`
20. `What is the chemical symbol for gold?` -> `Au`
21. `Who wrote the play Romeo and Juliet?` -> `William Shakespeare`
22. `What is the largest planet in the Solar System?` -> `Jupiter`
23. `삼성전자 종목코드는?` -> `005930`
24. `SK하이닉스 종목코드는?` -> `000660`

## The asymmetry worth keeping in mind

Preserving these is the trainer's *goal*, so a locality set drawn from the same well would report
zero damage no matter how much damage there was. Locality has to be measured somewhere the
regulariser was not aiming.
