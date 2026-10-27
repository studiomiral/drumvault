"""Entry point: `python -m drumvault_engine [rpc]` (default) or `python -m drumvault_engine cli ...`."""

import sys


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "cli":
        from .cli import main as cli_main
        return cli_main(args[1:])
    if args and args[0] not in ("rpc",):
        print("usage: python -m drumvault_engine [rpc | cli <command> ...]", file=sys.stderr)
        return 2
    from .rpc import main as rpc_main
    return rpc_main()


if __name__ == "__main__":
    sys.exit(main())
