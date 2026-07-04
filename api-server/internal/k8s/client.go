package k8s

import (
	"os"
	"path/filepath"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// NewClient creates a k8s client: in-cluster config first, then kubeconfig fallback.
func NewClient() (*kubernetes.Clientset, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		// Fall back to kubeconfig (development)
		home, _ := os.UserHomeDir()
		kc := filepath.Join(home, ".kube", "config")
		if kp := os.Getenv("KUBECONFIG"); kp != "" {
			kc = kp
		}
		cfg, err = clientcmd.BuildConfigFromFlags("", kc)
		if err != nil {
			return nil, err
		}
	}
	cfg.QPS = 50
	cfg.Burst = 100
	return kubernetes.NewForConfig(cfg)
}

// NewExecConfig builds a rest.Config for the dedicated exec-only
// ServiceAccount (see helm/templates/serviceaccount-exec.yaml and
// docs/EXEC_IDENTITY_ASSESSMENT.md). It reuses the pod's in-cluster
// host/CA -- identical for every ServiceAccount in the cluster -- but reads
// the bearer token from tokenFile, a separately mounted Secret, instead of
// the pod's own default ServiceAccount token. This lets api-server hold two
// distinct Kubernetes identities in one pod: its normal cluster-wide
// read-only ServiceAccount (NewClient above), and this narrowly-scoped
// exec-only one, without granting pods/exec to the former.
func NewExecConfig(tokenFile string) (*rest.Config, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, err
	}
	cfg.BearerToken = ""
	cfg.BearerTokenFile = tokenFile
	return cfg, nil
}
