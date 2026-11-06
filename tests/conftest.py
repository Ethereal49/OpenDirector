"""Bind infrastructure ports before tests construct application services.

Pytest loads this module before importing test modules.
"""
from opendirector.wiring import configure_runtime

configure_runtime()
