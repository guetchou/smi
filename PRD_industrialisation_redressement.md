# PRD — Remise aux normes industrielles de Tala SMI

## Problem Statement

Le projet Tala SMI a evolue rapidement sans discipline architecturale suffisante. Le resultat est une dette technique critique : plusieurs modules semblent complets dans l'interface, mais les interconnexions metier restent fragiles, partielles ou incoherentes.

Le probleme principal n'est plus d'ajouter des fonctionnalites. La priorite est de stabiliser l'existant, de rendre les workflows fiables, de centraliser les regles metier et d'interdire toute nouvelle dette.

Les defauts constates sont :

- synchronisation partielle entre fiche agent, compte utilisateur, roles, profils et permissions ;
- coexistence de deux modeles d'acces : roles historiques et profils/permissions ERP ;
- workflow RH de creation de compte qui ne garantit pas la synchronisation des profils modules ;
- traces SQLite et scripts anciens alors que la production tourne sous MySQL ;
- logique metier dispersee entre routes, services, migrations et frontend ;
- etats metier non centralises pour pointeuse, caisse, achats, paie, conges et sanctions ;
- controles anti-doublons presents localement mais non systematises ;
- donnees RH incompletes qui cassent l'experience agent : email, PIN pointeuse, departement, contrat, affectation ;
- UI qui masque parfois mal la separation entre vue agent et vue supervision ;
- tests insuffisants sur les flux complets agent -> compte -> modules -> action metier.

## Solution

Mettre le code aux normes industrielles en construisant un socle stable autour de quatre axes :

1. Identite et acces centralises.
2. Workflows metier explicites et testes.
3. Migration MySQL finalisee, sans ambiguite SQLite en production.
4. Gouvernance anti-dette : audit, tests, nettoyage, documentation et CI.

L'application doit fonctionner comme un ERP : un agent a une fiche RH, un compte utilisateur lie, des profils actifs, des permissions effectives et un tableau de bord compose uniquement des modules autorises. La pointeuse reste le module par defaut de tout agent, mais les modules Finance, RH, Caisse, Achats, Salaires, DG, Audit, Stock ou Commercial ne doivent apparaitre que s'ils sont assignes.

## User Stories

1. As an agent, I want to see only my assigned modules, so that I do not access data outside my responsibilities.
2. As an agent, I want the pointeuse to be available by default, so that I can check in without needing a separate module assignment.
3. As an agent, I want the pointeuse to recognize my linked employee record automatically, so that I do not select myself manually.
4. As an agent, I want to see my own attendance status and counters, so that I know if I am present, late, absent, checked out or incomplete.
5. As an agent, I want to see my own leave and overtime status when allowed, so that attendance data is meaningful.
6. As an RH user, I want creating an employee account to automatically assign the correct profiles, so that roles and modules stay synchronized.
7. As an RH user, I want to know when an employee has no linked user account, so that onboarding can be completed.
8. As an RH user, I want to know when a user account is not linked to an active employee, so that invalid access is blocked.
9. As an RH user, I want employee lifecycle events to revoke access automatically, so that exited employees cannot keep logging in.
10. As an admin, I want one central identity/access service, so that no route writes users and profiles inconsistently.
11. As an admin, I want direct user creation and RH user provisioning to share the same synchronization rules, so that no workflow bypasses module assignment.
12. As an admin, I want to activate or deactivate modules by user or profile, so that access follows the organization model.
13. As a DG, I want to see only supervision views, so that I do not accidentally perform operational actions meant for agents.
14. As a finance user, I want cash and salary permissions to be explicit, so that payment, validation and reporting are separated.
15. As a cashier, I want to pay approved transactions but not approve them, so that segregation of duties is respected.
16. As an auditor, I want every status change to be traceable, so that accountability is complete.
17. As an auditor, I want manual attendance changes to be marked separately, so that fraud investigations are possible.
18. As an admin, I want duplicate technical files and obsolete scripts to be identified before deletion, so that cleanup does not remove compatibility code by mistake.
19. As a developer, I want MySQL to be the only production database path, so that runtime behavior is predictable.
20. As a developer, I want SQLite references either removed or explicitly documented as migration-only, so that no one confuses local legacy code with production architecture.
21. As a developer, I want workflow states centralized, so that invalid transitions cannot be introduced by one route.
22. As a developer, I want tests around business interfaces rather than implementation details, so that refactoring remains safe.
23. As a product owner, I want a visible redressement board, so that every debt item has an owner, a status and a verification criterion.
24. As a user, I want refresh to preserve the current dashboard view, so that navigation is stable.
25. As an admin, I want user edit and deactivation flows to work from the UI, so that operational access can be managed without database intervention.
26. As a finance user, I want encaissement and decaissement forms to load rubriques reliably, so that operations can be recorded.
27. As a finance user, I want operation totals to be numeric, so that reports do not concatenate MySQL decimal strings.
28. As an RH user, I want salary totals to be numeric, so that payroll reports are reliable.
29. As an RH user, I want attendance, absences, leave and overtime to be connected, so that attendance data drives HR decisions.
30. As a DG, I want sanctions and warnings to be linked to attendance rules, so that repeated lateness or absence has a controlled workflow.
31. As an admin, I want notification failures to be non-blocking, so that secondary modules never crash core operations.
32. As a developer, I want CI to block code that introduces untracked build artifacts or obsolete backups, so that the repository stays clean.
33. As a developer, I want migrations to be idempotent, so that deployments can run safely multiple times.
34. As an operator, I want rollback instructions for every deployment, so that production incidents can be reversed.
35. As a user, I want long forms to be split into clear steps, so that data entry is reliable and readable.
36. As a user, I want grids and action buttons to have stable sizes, so that the UI works on production screens.
37. As an admin, I want profiles similar to ERP groups, so that assignment is understandable and repeatable.
38. As a developer, I want every module to expose a narrow tested interface, so that business logic is not duplicated in routes.
39. As a developer, I want obsolete code deletion to be based on dependency search and tests, so that cleanup is safe.
40. As a stakeholder, I want the application to be defensible as industrial-grade, so that it can be used beyond a local prototype.

## Implementation Decisions

- Build one deep module named `IdentityAccessService`.
- `IdentityAccessService` owns employee-user linking, role normalization, profile synchronization, permission recalculation and access revocation.
- Direct user creation, user update and RH employee account provisioning must call the same service.
- The service interface must expose stable operations: provision account for employee, update user access, sync profiles from roles, audit effective access, revoke access for exited employee.
- A user with an operational role must be linked to one active employee, except admin and DG emergency accounts.
- A linked employee can have only one active user account.
- Every account provisioning flow must run profile synchronization synchronously and fail the request if synchronization fails.
- Legacy roles remain readable during transition, but new authorization decisions must rely on effective permissions.
- A migration must resynchronize all existing users from roles to profiles after the service is introduced.
- A migration must keep operational unlinked accounts inactive unless explicitly exempted.
- Pointeuse access remains outside paid/business module assignment, but still requires an active linked employee for agent self-service.
- Admin/RH/DG supervision routes and agent self-service routes must return different data scopes.
- Manual pointage by admin/RH must be distinguished from agent pointage.
- Attendance statuses must be formalized as a state machine: absent, present, late, checked_out, incomplete, offsite, manual_adjustment.
- Decaissement statuses must be formalized as a state machine: draft, submitted, approved, paid, rejected, cancelled.
- Payroll statuses must be formalized as a state machine: generated, validated, submitted_to_dg, approved_by_dg, paid, cancelled.
- Leave and absence statuses must be formalized and linked to attendance where possible.
- Notifications must be non-blocking for core transactions.
- Numeric money fields from MySQL must be normalized before arithmetic in reports.
- The production database contract is MySQL. SQLite can only remain as a documented migration adapter if still required.
- Scripts that mention SQLite must be classified as keep, migrate, or delete.
- Duplicate cleanup must be evidence based: no deletion without dependency search, test coverage and rollback path.
- `node_modules`, generated reports and `.codex_backups` are excluded from duplicate-file analysis.
- PRDs and workflow documents must be reconciled so that "project complete" cannot coexist with known critical debt.
- CI must include syntax checks, migration checks, effective-access audit, smoke API tests and repository cleanliness checks.
- UI navigation state must persist across refresh.
- UI module visibility must be computed from effective permissions, not hardcoded role labels.

## Testing Decisions

- Tests must verify external behavior through public module interfaces and HTTP APIs.
- Tests must not assert internal SQL shape unless the SQL is itself the contract.
- Identity/access tests are mandatory because this is the highest-risk seam.
- Workflow state tests are mandatory because invalid transitions create financial and HR risk.
- Pointeuse tests are mandatory because this is the default agent workflow.
- Payroll and cash report tests must assert numeric totals, not string formatting.
- Module visibility tests must verify both frontend visibility and backend rejection.
- Provisioning tests must cover employee -> user -> profiles -> effective permissions.
- Negative tests must cover operational user without employee link.
- Negative tests must cover employee already linked to another user.
- Negative tests must cover inactive or exited employee.
- Smoke tests must cover health, login, dashboard, pointeuse self-service, operations list, salary report and access overview.
- Existing tests in `tests/modules_ventes_test.js`, `tests/caisse.spec.js`, `tests/conges_smoke.js` and related Playwright files should be reused as prior art.
- Every migration must be tested for idempotence.
- Every cleanup deletion must be tested by `rg` dependency search before removal and smoke tests after removal.

## Out of Scope

- Adding new business modules unrelated to stabilization.
- Rebuilding the frontend from scratch.
- Changing hosting provider or reverse proxy architecture.
- Replacing MySQL with another database.
- Full biometric attendance implementation.
- Full Odoo or Dolibarr feature parity.
- Historical data correction without explicit business validation.
- Destructive database cleanup without backup and rollback approval.

## Further Notes

The target is not to copy Odoo or Dolibarr feature by feature. The target is to adopt the industrial principles visible in mature ERP systems: explicit users, employee records, groups/profiles, permissions, module assignment, stateful workflows, auditability, and controlled deployment.

Current factual status:

- Production uses Docker and MySQL.
- Active operational users are currently linked and have active profiles.
- The remaining defect is architectural: not every code path guarantees that this remains true.
- The RH account provisioning path must be fixed first because it can create future inconsistencies.
- The repository is currently clean, but historical backup folders and SQLite compatibility code must be classified before any deletion.

Definition of done:

- No active operational user can exist without an active employee link.
- No active operational user can exist without synchronized effective profiles.
- A new user created from RH receives the expected modules immediately.
- An agent sees pointeuse by default and only assigned modules beyond pointeuse.
- Admin/RH/DG supervision views are separated from agent self-service views.
- Finance, RH, salary and cash reports produce numeric totals.
- CI blocks regressions on identity, access, workflows, migrations and repository cleanliness.
- Documentation no longer claims completion while critical debt remains open.
