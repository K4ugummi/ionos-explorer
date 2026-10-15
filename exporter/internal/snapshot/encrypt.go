package snapshot

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"filippo.io/age"
)

// Recipients builds the age recipients for the --recipient,
// --recipients-file and --passphrase-file flags. No flags means no
// encryption.
func Recipients(recipients []string, recipientsFile, passphraseFile string) ([]age.Recipient, error) {
	var out []age.Recipient
	for _, r := range recipients {
		rcp, err := age.ParseX25519Recipient(r)
		if err != nil {
			return nil, fmt.Errorf("--recipient %q: %w", r, err)
		}
		out = append(out, rcp)
	}
	if recipientsFile != "" {
		f, err := os.Open(recipientsFile)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		rcps, err := age.ParseRecipients(f)
		if err != nil {
			return nil, fmt.Errorf("--recipients-file: %w", err)
		}
		out = append(out, rcps...)
	}
	if passphraseFile != "" {
		if len(out) > 0 {
			// age does not allow mixing scrypt with other recipients.
			return nil, errors.New("--passphrase-file cannot be combined with recipients")
		}
		b, err := os.ReadFile(passphraseFile)
		if err != nil {
			return nil, err
		}
		pass := strings.TrimRight(string(b), "\r\n")
		if pass == "" {
			return nil, errors.New("--passphrase-file is empty")
		}
		rcp, err := age.NewScryptRecipient(pass)
		if err != nil {
			return nil, err
		}
		out = append(out, rcp)
	}
	return out, nil
}
