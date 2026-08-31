# @tightarse/truelayer

TrueLayer client, kept behind a narrow interface.

The interface exists so the provider is swappable — GoCardless Bank Account Data
is the fallback if TrueLayer's production onboarding proves awkward for a
personal-scale application. Nothing outside this package should know which
provider is in use.

Credentials are read from Secrets Manager at runtime. Never from a file.
