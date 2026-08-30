# Architecture decision records

An ADR records one decision, why it was taken, and what it costs. They live in
`docs/architecture/adrs/`, numbered, and are never edited once accepted — a
decision that changes gets a new record superseding the old one.

## Shape

```
# N. The decision, as a sentence

Status: proposed | accepted | superseded by ADR M
Date:
Issue:

## Context      what was true that made a decision necessary
## Decision     what we chose, in the present tense
## Consequences what follows, including what it costs
```

## One decision per record

If a record needs three sections to explain what it decided, it is three records.
If three records repeat each other's context, they are one.

The test is the title. A record whose title is a sentence you could disagree with
is one decision. "Lay the packages out as ports and adapters" is a decision;
"Repository structure" is a topic, and topics grow until nobody reads them.

## Write the cost down

The consequences section is the part that earns the record. Anyone can reconstruct
what was chosen by reading the code; nobody can reconstruct what it was chosen
over, or what was known to be wrong with it at the time.

Record the alternative that was rejected and why, especially when it was
reasonable. A record that makes the decision sound obvious is a record that will
be reversed by someone who thinks they have spotted something.

## Length

Shorter than you want it. Context and consequences carry the weight; the decision
itself is usually a paragraph.

Do not list what the decision is *not*, do not restate the same point in three
registers, and do not explain a convention the reader can see in the tree. Prose
that exists to demonstrate thoroughness reads as padding, because it is.
