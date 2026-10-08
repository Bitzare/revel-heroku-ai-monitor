package payments

import (
	"log"
	"net/http"

	"github.com/julienschmidt/httprouter"
)

func PostCoinPackIntent(w http.ResponseWriter, req *http.Request, pm httprouter.Params) {
	intent, err := createIntent(req)
	if err != nil {
		log.Printf("[PostCoinPackIntent] Failed to create payment intent user_id=%d: %v\n", 1, err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	_ = intent
	w.WriteHeader(http.StatusOK)
}

func createIntent(req *http.Request) (string, error) {
	return "", nil
}
