---
name: legal-risk-assessment
description: Assess and classify legal risks using a severity-by-likelihood framework. Use when evaluating contract risk, assessing deal exposure, or classifying issues by severity.
---

# Legal Risk Assessment

The user invoked this skill through `/legal-risk-assessment` or `/skill:legal-risk-assessment`.
They want help evaluating, classifying, or documenting legal risks for a contract, deal, or legal matter.

**Important**: You assist with legal workflows but do not provide legal advice. Risk assessments should be reviewed by qualified legal professionals.

## Risk Assessment Framework

### Severity x Likelihood Matrix

Legal risks are assessed on two dimensions:

**Severity** (impact if the risk materializes):

| Level | Label | Description |
|---|---|---|
| 1 | **Negligible** | Minor inconvenience; no material financial, operational, or reputational impact. |
| 2 | **Low** | Limited impact; minor financial exposure (< 1% of relevant value); minor operational disruption. |
| 3 | **Moderate** | Meaningful impact; material financial exposure (1-5% of relevant value); noticeable operational disruption. |
| 4 | **High** | Significant impact; substantial financial exposure (5-25% of relevant value); significant operational disruption; likely public attention. |
| 5 | **Critical** | Severe impact; major financial exposure (> 25% of relevant value); fundamental business disruption; significant reputational damage; regulatory action likely. |

**Likelihood** (probability the risk materializes):

| Level | Label | Description |
|---|---|---|
| 1 | **Remote** | Highly unlikely to occur; no known precedent in similar situations. |
| 2 | **Unlikely** | Could occur but not expected; limited precedent. |
| 3 | **Possible** | May occur; some precedent exists; triggering events are foreseeable. |
| 4 | **Likely** | Probably will occur; clear precedent; triggering events are common. |
| 5 | **Almost Certain** | Expected to occur; strong precedent or pattern; triggering events are present or imminent. |

### Risk Score Calculation

**Risk Score = Severity x Likelihood**

| Score Range | Risk Level | Color |
|---|---|---|
| 1-4 | **Low Risk** | GREEN |
| 5-9 | **Medium Risk** | YELLOW |
| 10-15 | **High Risk** | ORANGE |
| 16-25 | **Critical Risk** | RED |

### Risk Matrix Visualization

```
                    LIKELIHOOD
                Remote  Unlikely  Possible  Likely  Almost Certain
                  (1)     (2)       (3)      (4)        (5)
SEVERITY
Critical (5)  |   5    |   10   |   15   |   20   |     25     |
High     (4)  |   4    |    8   |   12   |   16   |     20     |
Moderate (3)  |   3    |    6   |    9   |   12   |     15     |
Low      (2)  |   2    |    4   |    6   |    8   |     10     |
Negligible(1) |   1    |    2   |    3   |    4   |      5     |
```

## Assessment Flow

1. **Gather context.** Ask the user for:
   - The contract, deal, or matter being assessed
   - Any specific clauses or issues they are concerned about
   - Relevant financial exposure or deal value (if known)
   - Jurisdiction or regulatory context (if relevant)

2. **Identify risks.** List the key legal risks visible from the context provided.

3. **Score each risk.** For each identified risk, assign:
   - Severity (1-5) with rationale
   - Likelihood (1-5) with rationale
   - Risk Score and Risk Level (GREEN/YELLOW/ORANGE/RED)

4. **Recommend actions.** Based on the risk level, suggest:
   - Mitigation strategies
   - Escalation path (if needed)
   - Monitoring plan

5. **Document.** Provide a structured risk assessment memo using the format below.

## Risk Classification Levels with Recommended Actions

### GREEN -- Low Risk (Score 1-4)
- **Accept** and proceed with standard controls
- **Document** in the risk register
- **Monitor** periodically (quarterly or annually)
- No escalation required

### YELLOW -- Medium Risk (Score 5-9)
- **Mitigate**: Implement specific controls or negotiate to reduce exposure
- **Monitor actively** at regular intervals
- **Assign owner** for monitoring and mitigation
- **Brief stakeholders** on the risk and mitigation plan

### ORANGE -- High Risk (Score 10-15)
- **Escalate to senior counsel**
- **Develop mitigation plan** with specific actions
- **Brief leadership** on the risk and recommended approach
- **Consider outside counsel** for specialized advice
- **Set review cadence** (weekly or at milestones)

### RED -- Critical Risk (Score 16-25)
- **Immediate escalation** to General Counsel and/or C-suite
- **Engage outside counsel** immediately
- **Establish response team** with clear roles
- **Daily or more frequent review** until resolved
- **Board reporting** as appropriate

## Risk Assessment Memo Format

```
## Legal Risk Assessment

**Date**: [assessment date]
**Assessor**: [person conducting assessment]
**Matter**: [description of the matter being assessed]

### 1. Risk Description
[Clear, concise description of the legal risk]

### 2. Background and Context
[Relevant facts, history, and business context]

### 3. Risk Analysis

#### Severity Assessment: [1-5] - [Label]
[Rationale for severity rating]

#### Likelihood Assessment: [1-5] - [Label]
[Rationale for likelihood rating]

#### Risk Score: [Score] - [GREEN/YELLOW/ORANGE/RED]

### 4. Contributing Factors
[What factors increase the risk]

### 5. Mitigating Factors
[What factors decrease the risk or limit exposure]

### 6. Mitigation Options

| Option | Effectiveness | Cost/Effort | Recommended? |
|---|---|---|---|
| [Option 1] | [High/Med/Low] | [High/Med/Low] | [Yes/No] |
| [Option 2] | [High/Med/Low] | [High/Med/Low] | [Yes/No] |

### 7. Recommended Approach
[Specific recommended course of action with rationale]

### 8. Residual Risk
[Expected risk level after implementing recommended mitigations]

### 9. Monitoring Plan
[How and how often the risk will be monitored]

### 10. Next Steps
1. [Action item 1 - Owner - Deadline]
2. [Action item 2 - Owner - Deadline]
```

## When to Escalate to Outside Counsel

### Mandatory Engagement
- Active litigation
- Government investigation
- Criminal exposure
- Securities issues
- Board-level matters

### Strongly Recommended
- Novel legal issues
- Jurisdictional complexity
- Material financial exposure
- Specialized expertise needed
- M&A transactions

### Consider Engagement
- Complex contract disputes
- Employment matters
- Data incidents
- IP disputes
- Insurance coverage disputes
```
