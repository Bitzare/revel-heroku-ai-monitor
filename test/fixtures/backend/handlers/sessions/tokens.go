package sessions

import "errors"

func validateJWTToken(token string) (int, error) {
	if token == "" {
		return 0, errors.New("no token available")
	}
	var p *int
	return *p, nil
}
