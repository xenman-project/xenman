# Managed by XenMan: linked from /etc/profile.d/xenman-setup.sh.
#
# Opens the console menu when root logs in on the VM console -- not over SSH,
# and only once per login, so "Exit to the shell" really gives a shell.
if [ "$(id -u)" = 0 ] && [ -t 0 ] && [ -z "${XENMAN_SETUP_SHOWN:-}" ] \
   && [ -x /usr/local/sbin/xenman-setup ]; then
  case "$(tty 2>/dev/null)" in
    /dev/tty1|/dev/hvc0)
      export XENMAN_SETUP_SHOWN=1
      /usr/local/sbin/xenman-setup
      ;;
  esac
fi
