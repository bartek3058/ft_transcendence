*This project has been created as part of the 42 curriculum by astefans, brogalsk, tszymans, pjedrycz and pmamala*

# ft_transcendence

## Description

### Goal
The purpose of this project is to create a chess application including multiuser/multiplayer mode, tournament options, scoring system and AI integration.

### Overview

# Instruction


# Information about team

| Member | Role | Main Responsibilities |
|--------|------|-----------------------|
| tszymans| Product Owner |             |
| pjedrycz| Project Manager |           |
| brogalsk| Tech Lead |                 |
| astefans| Developer |                 |
| pmamala | Developer |                 |

## Authentication implementation contracts

The current backend uses NestJS/Express, and the frontend uses React/Vite. PostgreSQL and Prisma are planned. Authentication stage 1 provides input validation and password hashing; account/session endpoints are not implemented yet.

- [Database teammate handoff](docs/auth-database-handoff.md): tables, constraints, indexes, connection provider, migrations, configuration and acceptance checks.
- [Authentication input and API contract](docs/auth-input-contract.md): normalization, validation, password handling, endpoint behavior and security tests.
- [Stage 1 implementation guide](docs/auth-stage-one.md): code walkthrough, test commands, implementation boundaries and remaining work.
