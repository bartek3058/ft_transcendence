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

The current backend uses NestJS/Express, and the frontend uses React/Vite. PostgreSQL and Prisma schema, migrations, bootstrap and connection module are integrated. Authentication routes, input validation, password hashing and cookie-session orchestration are implemented against a repository interface. The Prisma authentication adapter is connected and verified against PostgreSQL. Fast tests use a test-only repository; dedicated integration tests exercise the real application and database.

- [Registration and login testing](docs/auth-testing.md): automated PostgreSQL tests and manual HTTPS checks.
- [Database setup and verification](docs/database-setup.md): credentials, migrations, optional admin bootstrap and isolated database tests.
- [Database teammate handoff](docs/auth-database-handoff.md): tables, constraints, indexes, connection provider, migrations, configuration and acceptance checks.
- [Authentication input and API contract](docs/auth-input-contract.md): normalization, validation, password handling, endpoint behavior and security tests.
- [Stage 1 implementation guide](docs/auth-stage-one.md): code walkthrough, test commands, implementation boundaries and remaining work.
- [Stage 2 implementation guide](docs/auth-stage-two.md): registration/login/session flow, security guards, configuration, database integration and frontend examples.
