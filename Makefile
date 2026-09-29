UUID = app-volumes@kapustota.github.io
ZIP = $(UUID).shell-extension.zip
SOURCES = metadata.json extension.js backend.js stylesheet.css $(wildcard po/*.po)

.PHONY: pack install pot clean

pack: $(ZIP)

$(ZIP): $(SOURCES)
	gnome-extensions pack --force --extra-source=backend.js --podir=po --out-dir=. .

install: $(ZIP)
	gnome-extensions install --force $(ZIP)

pot:
	xgettext --from-code=UTF-8 --language=JavaScript --package-name=app-volumes \
	    --msgid-bugs-address=https://github.com/kapustota/gnome-app-volumes/issues \
	    --output=po/app-volumes.pot extension.js backend.js

clean:
	rm -f $(ZIP)
